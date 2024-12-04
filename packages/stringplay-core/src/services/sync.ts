import { drive_v3, forms_v1, sheets_v4 } from "googleapis";
import { getDrive, getForms, getSheets } from "../cloud/gcp";
import { AttendeeSchema, BaseMemberProperties, EventDataSource, EventsAttendedBucketSchema, EventSchema, EventTypeSchema, MemberPropertyValue, MemberSchema, TroupeDashboardSchema, TroupeLimit, TroupeSchema, VariableMemberProperties } from "../types/core-types";
import { DRIVE_FOLDER_MIME, DRIVE_FOLDER_REGEX, DRIVE_FOLDER_URL_TEMPL, EVENT_DATA_SOURCE_MIME_TYPES, EVENT_DATA_SOURCE_URLS, EVENT_DATA_SOURCES, FORMS_REGEX, FORMS_URL_TEMPL, FULL_DAY, MAX_PAGE_SIZE, EVENT_DATA_SOURCE_MIME_QUERIES, SHEETS_URL_TEMPL } from "../util/constants";
import { AggregationCursor, AnyBulkWriteOperation, BulkWriteResult, DeleteResult, ObjectId, UpdateFilter, UpdateResult, WithId } from "mongodb";
import { getDataSourceId, getDataSourceUrl, getDefaultMemberPropertyValue } from "../util/helper";
import { DiscoveryEventType, EventDataMap, FolderToEventTypeMap, GoogleFormsQuestionToTypeMap, AttendeeDataMap, TroupeLimitSpecifier } from "../types/service-types";
import { GaxiosResponse, GaxiosError } from "gaxios";
import { Mutable, SetOperator } from "../types/util-types";
import { GoogleFormsEventDataService } from "./sync/events/gforms-event";
import { GoogleSheetsEventDataService } from "./sync/events/gsheets-event";
import assert from "assert";
import { GoogleSheetsLogService } from "./sync/logs/gsheets-log";
import { LimitService } from "./limits";
import { EventDataService } from "./sync/base";
import { BaseDbService } from "./base";

export class SyncService extends BaseDbService {
    constructor() { super() }

    async sync(troupeId: string, skipLogPublish?: true): Promise<void> {
        await SyncTroupe.create().then(handler => handler.sync(troupeId, skipLogPublish));
    }
}

/**
 * Synchronizes a single troupe with its source uris for events and event types, then updates the
 * audience and log sheet with the new information.
 * 
 * - Doesn't delete events previously discovered, even if not found in parent event type folder
 * - Delete members that are no longer in the source folder & have no overridden properties
 * - NOTE: Populate local variables with synchronized information to update the database
 */
export class SyncTroupe extends BaseDbService {
    drive!: drive_v3.Drive;
    limitService!: LimitService;
    currentLimits!: TroupeLimit;

    // Output variables
    troupe: WithId<TroupeSchema> | null;
    dashboard: WithId<TroupeDashboardSchema> | null;
    eventMap: EventDataMap;
    attendeeMap: AttendeeDataMap;
    incrementLimits: TroupeLimitSpecifier;

    constructor() {
        super();
        this.ready = this.init();

        this.troupe = null;
        this.dashboard = null;
        this.eventMap = {};
        this.attendeeMap = {};
        this.incrementLimits = {
            eventsLeft: 0,
            sourceFolderUrisLeft: 0,
            membersLeft: 0,
        };
    }

    private async init() {
        this.drive = await getDrive();
        this.limitService = await LimitService.create();
    }

    /**
     * Synchronize the troupe with all of its source uris for events and event types, then
     * updates the audience and log sheet with the new information.
     * 
     * - Doesn't delete events previously discovered, even if not found in parent
     *   event type folder
     * - Delete members that are no longer in the source folder & have no overridden properties
     * - NOTE: Populate local variables with synchronized information to update the database
     */
    async sync(troupeId: string, skipLogPublish?: true): Promise<void> {
        assert(!(await this.getTroupeSchema(troupeId)).syncLock, "Troupe is already being synced");

        // Lock the troupe
        this.troupe = await this.troupeColl.findOneAndUpdate(
            { _id: new ObjectId(troupeId) },
            { $set: { syncLock: true } },
            { returnDocument: "after" },
        );
        assert(this.troupe, "Failed to lock troupe for sync");

        try {
            this.dashboard = await this.dashboardColl.findOne({ troupeId });
            assert(this.dashboard, "Failed to get dashboard for sync");
    
            const limits = await this.limitService.getTroupeLimits(troupeId);
            assert(limits, "No limits document found for troupe");
            this.currentLimits = limits;
    
            // Perform sync
            await this.discoverEvents();
            await this.discoverAndRefreshAudience();
            await this.persistSync();
            if(!skipLogPublish) await this.refreshLogSheet();
        } catch(e) {
            console.error('Unable to complete troupe sync.');
            console.error('Reason:', e);
        }
        
        // Unlock the troupe
        const unlockResult = await this.troupeColl.updateOne(
            { _id: new ObjectId(troupeId) },
            { $set: { syncLock: false } },
        );
        assert(unlockResult.modifiedCount === 1, "Failed to unlock troupe after sync");
    }

    /** Discovers events found from the given event types in the troupe */
    protected async discoverEvents(): Promise<void> {
        assert(this.troupe);
        const troupeId = this.troupe._id.toHexString();

        // Initialize existing events
        for await(const event of this.eventColl.find({ troupeId })) {
            event.synchronizedSource = event.source;
            event.synchronizedSourceUri = event.sourceUri;
            event.synchronizedFieldToPropertyMap = event.fieldToPropertyMap;
            this.eventMap[event.sourceUri] = { event, fromColl: true };
        }

        /**
         * == BEGIN EVENT TYPE INITIALIZATION == 
         * Current event types will be mapped to the Google Drive folders they contain,
         * and tie breakers will be handled accordingly.
         */

        // To help with tie breaking, keep track of the folders that have been discovered
        const folderToEventTypeMap: FolderToEventTypeMap = {};

        // Populate the array with the IDs of all the event type folders for this troupe
        const foldersToExplore: string[] = [];
        for(const eventType of this.troupe.eventTypes) {
            const discoveryEventType = { ...eventType, totalFiles: 0 };

            for(const folder of eventType.sourceFolderUris) {
                const folderId = getDataSourceId("Google Drive Folder", folder)!;
                const winningEventType = this.performEventTypeTieBreaker(
                    folderToEventTypeMap, folderId, discoveryEventType
                );

                // Update the winning event type and add the folder to the list of folders to explore
                if(winningEventType != folderToEventTypeMap[folderId]) {
                    if(folderToEventTypeMap[folderId]) {
                        folderToEventTypeMap[folderId].totalFiles -= 1;
                    }
                    
                    winningEventType.totalFiles += 1;
                    folderToEventTypeMap[folderId] = winningEventType;
                    foldersToExplore.push(folderId);
                }
            }
        }

        /**
         * == BEGIN EVENT DISCOVERY == 
         * New events and event types will be collected from Google Drive.
         */

        // Iterate through all discovered folders and their children for events
        const discoveredFolders: string[] = [];
        while(foldersToExplore.length > 0) {
            const folderId = foldersToExplore.pop()!;
            if(discoveredFolders.includes(folderId)) continue;
            discoveredFolders.push(folderId);

            // Get the folder's children
            let response: GaxiosResponse<drive_v3.Schema$FileList>;
            try {
                const q = `(${EVENT_DATA_SOURCE_MIME_QUERIES.join(" or ")}) and '${folderId}' in parents`;
                response = await this.drive.files.list(
                    { q, fields: "files(id, name, mimeType)", }
                );
            } catch(e) {
                console.warn("Error getting data for folder " + folderId + ". Skipping...");
                console.warn("Problem:", e);

                // Remove the folder from its event type, the map, and the list of folders to explore
                folderToEventTypeMap[folderId].sourceFolderUris = 
                    folderToEventTypeMap[folderId].sourceFolderUris.filter(id => id != folderId);
                delete folderToEventTypeMap[folderId];
                discoveredFolders.pop();
                continue;
            }
            const files = response.data.files;
            if(!files) continue;
            
            // Go through the files in the Google Drive folders
            const currentDiscoveryEventType = folderToEventTypeMap[folderId];
            for(const file of files) {
                let source: EventDataSource = "";
                let sourceUri = "";
                const eventDataSource = EVENT_DATA_SOURCE_MIME_TYPES.indexOf(
                    file.mimeType! as typeof EVENT_DATA_SOURCE_MIME_TYPES[number]
                );

                if(file.mimeType === DRIVE_FOLDER_MIME) {
                    const winningEventType = this.performEventTypeTieBreaker(
                        folderToEventTypeMap, folderId, currentDiscoveryEventType
                    );

                    // Update the winning event type and add the folder to the list of folders to explore
                    if(winningEventType != folderToEventTypeMap[folderId]) {
                        if(folderToEventTypeMap[folderId]) {
                            folderToEventTypeMap[folderId].totalFiles! -= 1;
                        } else {
                            if(this.currentLimits.sourceFolderUrisLeft === this.incrementLimits.sourceFolderUrisLeft) {
                                continue;
                            }

                            // This is a new folder that's within limits; increment the limits accordingly
                            this.incrementLimits.sourceFolderUrisLeft! -= 1;
                        }
                        
                        winningEventType.totalFiles! += 1;
                        folderToEventTypeMap[folderId] = winningEventType;
                        foldersToExplore.push(folderId);
                    }
                    continue;
                } else if(eventDataSource != -1) {
                    file.mimeType = EVENT_DATA_SOURCE_MIME_TYPES[eventDataSource];
                    source = EVENT_DATA_SOURCES[eventDataSource];
                    sourceUri = getDataSourceUrl(source, file.id!);
                } else {
                    continue;
                }

                // Convert the winning event type back to a regular event type
                const { totalFiles, ...currentEventType } = currentDiscoveryEventType;
                
                if(sourceUri in this.eventMap) {
                    const eventData = this.eventMap[sourceUri];
                    if(!eventData.event.eventTypeId) {
                        eventData.event.eventTypeId = currentEventType._id.toHexString();
                        eventData.event.eventTypeTitle = currentEventType.title;
                        eventData.event.value = currentEventType.value;
                    }
                } else {
                    if(this.currentLimits.eventsLeft === this.incrementLimits.eventsLeft) {
                        continue;
                    }

                    // Add the new event to the collection of events
                    const event: WithId<EventSchema> = {
                        _id: new ObjectId(),
                        troupeId,
                        lastUpdated: new Date(),
                        title: file.name!,
                        source,
                        synchronizedSource: source,
                        sourceUri,
                        synchronizedSourceUri: sourceUri,
                        startDate: file.createdTime ? new Date(file.createdTime) : new Date(),
                        eventTypeId: currentEventType._id.toHexString(),
                        eventTypeTitle: currentEventType.title,
                        value: currentEventType.value,
                        fieldToPropertyMap: {},
                        synchronizedFieldToPropertyMap: {},
                    };
                    this.eventMap[sourceUri] = { event, fromColl: false };
                    this.incrementLimits.eventsLeft! -= 1;
                }
            }
        }
    }

    /** Performs tie breaker between the given event type and the event type in the map */
    private performEventTypeTieBreaker(
        map: FolderToEventTypeMap, 
        folderId: string, 
        currentEventType: DiscoveryEventType,
    ) : DiscoveryEventType {
        const existingEventType = map[folderId];
        return !existingEventType
            ? currentEventType
            : existingEventType.totalFiles! < currentEventType.totalFiles!
            ? existingEventType
            : currentEventType;
    }
    
    /** 
     * Goes through event sign ups to discover audience, mark them as discovered, 
     * and update existing audience points. Drops invalid audience members.
     */
    protected async discoverAndRefreshAudience() {
        assert(this.troupe);
        const troupeId = this.troupe._id.toHexString();
        const lastUpdated = new Date();

        // Initialize audience members
        for await(const member of this.audienceColl.find({ troupeId })) {
            const eventsAttendedDocs = await this.eventsAttendedColl
                .find({ memberId: member._id.toHexString() })
                .sort({ page: 1 })
                .toArray();
            
            this.attendeeMap[member.properties["Member ID"].value] = {
                member,
                eventsAttended: [],
                eventsAttendedDocs,
                delete: false,
                fromColl: true,
            };

            // Reset points for each point type in the member
            for(const pointType of Object.keys(this.troupe.pointTypes)) {
                member.points[pointType] = 0;
            }

            // Reset properties for each non overridden property in the member
            const baseProps: VariableMemberProperties = {};
            for(const prop in this.troupe.memberPropertyTypes) {
                if(prop in member.properties && member.properties[prop].override) {
                    baseProps[prop] = member.properties[prop];
                } else {
                    baseProps[prop] = {
                        value: member.properties[prop]?.value,
                        override: false,
                    }
                }
            }
            member.properties = baseProps as MemberSchema["properties"];
            member.lastUpdated = lastUpdated;
        }
        
        // Discover audience members from events not flagged for deletion
        const audienceDiscovery = [];
        for(const sourceUri in this.eventMap) {
            const eventData = this.eventMap[sourceUri];
            audienceDiscovery.push(this.discoverAudience(eventData.event, lastUpdated));
        }
        await Promise.all(audienceDiscovery);

        // Get all the required properties from the troupe
        const requiredProperties = [];
        for(const prop in this.troupe.memberPropertyTypes) {
            if(this.troupe.memberPropertyTypes[prop].endsWith("!")) {
                requiredProperties.push(prop);
            }
        }

        // Mark members without required properties for deletion
        for(const memberId in this.attendeeMap) {
            const member = this.attendeeMap[memberId];
            for(const prop of requiredProperties) {
                if(!member.member.properties[prop].value) {
                    member.delete = true;
                    break;
                }
            }
        }
    }

    /**
     * Helper for {@link SyncTroupe.discoverAndRefreshAudience}. Discovers
     * audience information from a single event. 
     * 
     * Invariant: All events must have one field for the Member ID defined or else
     * no member information can be collected from it.
     */
    private async discoverAudience(event: WithId<EventSchema>, lastUpdated: Date): Promise<void> {
        assert(this.troupe);

        // Select a data service to collect event data from, and discover audience using the service
        let dataService: EventDataService;
        if(event.source === "Google Forms") {
            dataService = new GoogleFormsEventDataService(
                this.troupe, this.eventMap, this.attendeeMap, this.currentLimits, this.incrementLimits,
            );
        } else if(event.source == "Google Sheets") {
            dataService = new GoogleSheetsEventDataService(
                this.troupe, this.eventMap, this.attendeeMap, this.currentLimits, this.incrementLimits,
            );
        } else {
            // Invalid event, no audience to discover
            return;
        }
        await dataService.ready.then(() => dataService.discoverAudience(event, lastUpdated));
    }

    /** Persist new information retrieved from events to the database */
    async persistSync(): Promise<void> {
        assert(this.troupe && this.dashboard);
        const troupeId = this.troupe._id.toHexString();

        // Initialize dashboard to update with statistics from event & audience update
        const dashboardUpdate: SetOperator<TroupeDashboardSchema> = {
            lastUpdated: new Date(),
            upcomingBirthdays: { 
                frequency: this.dashboard.upcomingBirthdays.desiredFrequency,
                desiredFrequency: this.dashboard.upcomingBirthdays.desiredFrequency,
                members: []
            },
            totalMembers: 0,
            totalEvents: 0,
            totalEventTypes: this.troupe.eventTypes.length,
            totalAttendeesByEventType: {},
            totalEventsByEventType: {},
            avgAttendeesPerEvent: 0,
            avgAttendeesByEventType: {},
            attendeePercentageByEventType: {},
            eventPercentageByEventType: {},
        };

        // Initialize dashboard statistics
        for(const eventType of this.troupe.eventTypes) {
            const eventTypeId = eventType._id.toHexString();
            const title = eventType.title;
            const value = 0;
            const percent = 0;

            dashboardUpdate.totalAttendeesByEventType![eventTypeId] = { title, value };
            dashboardUpdate.totalEventsByEventType![eventTypeId] = { title, value };
            dashboardUpdate.avgAttendeesByEventType![eventTypeId] = { title, value };
            dashboardUpdate.attendeePercentageByEventType![eventTypeId] = { title, value, percent };
            dashboardUpdate.eventPercentageByEventType![eventTypeId] = { title, value, percent };
        }

        // Populate the events to update
        let updateEvents: WithId<EventSchema>[] = [];
        for(const sourceUri in this.eventMap) {
            const eventData = this.eventMap[sourceUri];
            const eventTypeId = eventData.event.eventTypeId;
            updateEvents.push(eventData.event);
            dashboardUpdate.totalEvents! += 1;

            if(eventTypeId) {
                dashboardUpdate.totalEventsByEventType![eventTypeId].value += 1;
                dashboardUpdate.eventPercentageByEventType![eventTypeId].value += 1;
            }
        }

        // Populate the members and events attended to update and delete arrays
        const birthdayCutoff = dashboardUpdate.upcomingBirthdays!.frequency == "weekly" 
            ? new Date(Date.now() + FULL_DAY * 7)
            : new Date(Date.now() + FULL_DAY * 30);

        let updateAudience: WithId<MemberSchema>[] = [];
        let membersToDelete: ObjectId[] = [];
        let updateEventsAttended: WithId<EventsAttendedBucketSchema>[] = [];
        let eventsAttendedToDelete: ObjectId[] = [];

        for(const memberIdProp in this.attendeeMap) {
            const memberData = this.attendeeMap[memberIdProp];
            const memberId = memberData.member._id.toHexString();

            // Delete the member and the events they've attended if they're marked for deletion
            if(memberData.delete && memberData.fromColl) {
                membersToDelete.push(memberData.member._id);
                eventsAttendedToDelete = eventsAttendedToDelete.concat(
                    memberData.eventsAttendedDocs.map(doc => doc._id)
                );
                continue;
            }
            updateAudience.push(memberData.member);

            // Update dashboard
            const birthday = memberData.member.properties["Birthday"].value;
            if(birthday && birthday < birthdayCutoff) {
                dashboardUpdate.upcomingBirthdays!.members.push({
                    id: memberId,
                    firstName: memberData.member.properties["First Name"].value,
                    lastName: memberData.member.properties["Last Name"].value,
                    birthday,
                });
            }
            dashboardUpdate.totalMembers! += 1;

            let page = 0;
            let docsProcessed = 0;
            while(docsProcessed < memberData.eventsAttended.length) {
                const events: EventsAttendedBucketSchema["events"] = {};

                // Initialize the events attended document
                let eventsAttendedDoc = memberData.eventsAttendedDocs[page];
                if(!eventsAttendedDoc) {
                    eventsAttendedDoc = {
                        _id: new ObjectId(),
                        troupeId,
                        memberId,
                        page,
                        events,
                    }
                };

                // Populate the events attended document with the events attended
                const startIndex = page * MAX_PAGE_SIZE;
                const endIndex = Math.min(startIndex + MAX_PAGE_SIZE, memberData.eventsAttended.length);
                for(let i = startIndex; i < endIndex; i++) {
                    const eventTypeId = memberData.eventsAttended[i].typeId
                    events[memberData.eventsAttended[i].eventId] = {
                        typeId: eventTypeId,
                        value: memberData.eventsAttended[i].value,
                        startDate: memberData.eventsAttended[i].startDate,
                    }

                    // Update dashboard
                    if(eventTypeId) {
                        dashboardUpdate.totalAttendeesByEventType![eventTypeId].value += 1;
                        dashboardUpdate.avgAttendeesByEventType![eventTypeId].value += 1;
                        dashboardUpdate.attendeePercentageByEventType![eventTypeId].value += 1;
                    }
                    dashboardUpdate.totalAttendees! += 1;
                }
                docsProcessed += endIndex - startIndex;

                // Update the events attended document
                updateEventsAttended.push(eventsAttendedDoc);
                page++;
            }

            // Remove the remaining preexisting documents
            eventsAttendedToDelete = eventsAttendedToDelete
                .concat(memberData.eventsAttendedDocs
                    .slice(page)
                    .map(doc => doc._id)
                );
        }

        // Complete dashboard data
        const totalAttendees = dashboardUpdate.totalAttendees!;
        const totalEvents = dashboardUpdate.totalEvents!;
        this.dashboard.avgAttendeesPerEvent = totalEvents > 0 ? Math.round(totalEvents / totalAttendees) : 0;
        
        for(const eventType of this.troupe.eventTypes) {
            const eventTypeId = eventType._id.toHexString();
            const totalEventsByEventType = dashboardUpdate.totalEventsByEventType![eventTypeId].value;
            const totalAttendeesByEventType = dashboardUpdate.totalAttendeesByEventType![eventTypeId].value;

            dashboardUpdate.avgAttendeesByEventType![eventTypeId].value = totalEventsByEventType > 0
                ? Math.round(dashboardUpdate.avgAttendeesByEventType![eventTypeId].value / totalEventsByEventType) : 0;
            dashboardUpdate.attendeePercentageByEventType![eventTypeId].value = totalAttendees > 0 
                ? totalAttendeesByEventType / totalAttendees : 0;
            dashboardUpdate.eventPercentageByEventType![eventTypeId].value = totalEvents > 0 
                ? totalEventsByEventType / totalEvents : 0;
        }

        await this.client.withSession(s => s.withTransaction(
            async () => {
                await this.dashboardColl.updateOne({ troupeId }, { $set: dashboardUpdate }, { upsert: true });

                if(updateEvents.length > 0) {
                    await this.eventColl.bulkWrite(updateEvents.map(event => ({
                        updateOne: {
                            filter: { _id: event._id },
                            update: { $set: event },
                            upsert: true,
                        }
                    } as AnyBulkWriteOperation<EventSchema>)));
                }

                if(updateAudience.length > 0) {
                    await this.audienceColl.bulkWrite(updateAudience.map(member => ({
                        updateOne: {
                            filter: { _id: member._id },
                            update: { $set: member },
                            upsert: true,
                        }
                    })));
                }
                await this.audienceColl.deleteMany({ _id: { $in: membersToDelete } });

                if(updateEventsAttended.length > 0) {
                    await this.eventsAttendedColl.bulkWrite(updateEventsAttended.map(bucket => ({
                        updateOne: {
                            filter: { _id: bucket._id },
                            update: { $set: bucket },
                            upsert: true,
                        }
                    })));
                }
                await this.eventsAttendedColl.deleteMany({ _id: { $in: eventsAttendedToDelete } });

                const updateLimits = await this.limitService.incrementTroupeLimits(troupeId, this.incrementLimits);
                assert(updateLimits, "Invalid state -- limits exceeded for sync operation. This is unintended behavior.");
            }
        ));
    }

    /** Update the log sheet with the new information from this sync */
    async refreshLogSheet() {
        const events = Object.keys(this.eventMap)
            .map(uri => this.eventMap[uri].event)
            .sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
        
        const audience = Object.keys(this.attendeeMap).map(m => {
            const member = this.attendeeMap[m].member;
            const attendee: WithId<AttendeeSchema> = {
                ...member,
                _id: new ObjectId(member._id.toHexString()),
                eventsAttended: {},
            };

            this.attendeeMap[m].eventsAttended.forEach(e => {
                attendee.eventsAttended[e.eventId] = {
                    typeId: e.typeId,
                    value: e.value,
                    startDate: e.startDate,
                }
            });

            return attendee;
        }).sort((a, b) => a.points["Total"] - b.points["Total"]);

        const logService = new GoogleSheetsLogService();
        await logService.updateLog(this.troupe!.logSheetUri, this.troupe!, events, audience);
    }
}
// Implementation for client-facing controller methods

import { AnyBulkWriteOperation, ClientSession, ObjectId, UpdateFilter, WithId } from "mongodb";
import { GDRIVE_FOLDER_REGEX, EVENT_DATA_SOURCES, EVENT_DATA_SOURCE_REGEX, MAX_EVENT_TYPES, MAX_POINT_TYPES, BASE_MEMBER_PROPERTY_TYPES, BASE_POINT_TYPES_OBJ, MAX_MEMBER_PROPERTIES, DEFAULT_MATCHERS, EVENT_FOLDER_DATA_SOURCE_REGEX, EVENT_FOLDER_DATA_SOURCES } from "../util/constants";
import { EventsAttendedBucketSchema, EventSchema, EventTypeSchema, VariableMemberProperties, MemberSchema, TroupeSchema, BaseMemberProperties, VariableMemberPoints, BaseMemberPoints, AttendeeSchema, FieldMatcher, TroupeLimit } from "../types/core-types";
import { Attendee, BulkUpdateEventRequest, BulkUpdateEventResponse, BulkUpdateEventTypeRequest, BulkUpdateEventTypeResponse, BulkUpdateMemberRequest, BulkUpdateMemberResponse, ConsoleData, CreateEventRequest, CreateEventTypeRequest, CreateMemberRequest, EventType, Member, PublicEvent, ApiEndpoints, Troupe, TroupeDashboard, UpdateEventRequest, UpdateEventTypeRequest, UpdateMemberRequest, UpdateTroupeRequest } from "../types/api-types";
import { Mutable, SetOperator, UnsetOperator, UpdateOperator } from "../types/util-types";
import { BaseDbService } from "./base";
import { ClientError } from "../util/error";
import { arrayToObject, asyncArrayToObject, asyncObjectMap, getEventDataSourceId, getEventFolderDataSourceId, objectMap, objectToArray, parseEventDataSourceUrl, parseEventFolderDataSourceUrl, verifyApiMemberPropertyType } from "../util/helper";
import { toAttendee, toEventType, toMember, toPublicEvent, toTroupe, toTroupeDashboard, toTroupeLimits } from "../util/api-transform";
import assert from "assert";
import { LimitService } from "./limits";
import { LimitContext, TroupeLimitSpecifier } from "../types/service-types";
import { UpdateTroupeRequestBuilder } from "./api/requests/update-troupe";
import { ApiRequestBuilder } from "./api/base";
import { UpdateEventRequestBuilder } from "./api/requests/update-event";
import { UpdateEventTypeRequestBuilder } from "./api/requests/update-event-type";
import { UpdateMemberRequestBuilder } from "./api/requests/update-member";
import { SyncService } from "./sync";

/**
 * Provides method definitions for the API. The structure of all given parameters will
 * not be checked (e.g. data type, constant range boundaries), but any checks requiring database access 
 * will be performed on each parameter.
 */
export class ApiService extends BaseDbService implements ApiEndpoints {
    syncService!: SyncService;
    limitService!: LimitService;

    constructor() { 
        super();
        this.ready = this.init();
    }

    private async init() {
        this.syncService = await SyncService.create();
        this.limitService = await LimitService.create();
    }

    async getConsoleData(troupeId: string): Promise<ConsoleData> {
        const console: Partial<ConsoleData> = {};
        const res = await Promise.all([
            this.getDashboard(troupeId),
            this.getLimits(troupeId),
            this.getTroupe(troupeId),
            this.getEvents(troupeId),
            this.getEventTypes(troupeId),
            this.getAttendees(troupeId),
        ] as const);
        
        console.dashboard = res[0];
        console.limits = res[1];
        console.troupe = res[2];
        console.events = res[3];
        console.eventTypes = res[4];
        console.attendees = res[5];
        return console as ConsoleData;
    }

    async getDashboard(troupeId: string): Promise<TroupeDashboard> {
        const dashboard = await this.getDashboardSchema(troupeId);
        return toTroupeDashboard(dashboard, dashboard._id.toHexString());
    }

    async getLimits(troupeId: string): Promise<TroupeLimit> {
        const idTroupeLimits = await this.limitService.getTroupeLimits(troupeId);
        assert(idTroupeLimits, new ClientError(`Invalid troupe ID: ${troupeId}`));

        const { _id, ...troupeLimits } = idTroupeLimits;
        return toTroupeLimits(troupeLimits, idTroupeLimits._id.toHexString());
    }

    async getTroupe(troupe: string | WithId<TroupeSchema>): Promise<Troupe> {
        const troupeObj = typeof troupe == "string" 
            ? await this.getTroupeSchema(troupe, true)
            : troupe;
        return toTroupe(troupeObj, troupeObj._id.toHexString());
    }

    async updateTroupe(troupeId: string, request: UpdateTroupeRequest): Promise<Troupe> {
        const [ newTroupe ] = await UpdateTroupeRequestBuilder.execute(troupeId, request);
        
        // Return public facing version of the new troupe
        return this.getTroupe(newTroupe);
    }

    async createEvent(
        troupeId: string, 
        request: CreateEventRequest, 
        session?: ClientSession,
        limitContext?: LimitContext,
    ) : Promise<PublicEvent> {
        const troupe = await this.getTroupeSchema(troupeId, true, session);
        assert(!troupe.syncLock, new ClientError("Cannot create event while sync is in progress"));

        const eventType = troupe.eventTypes.find((et) => et._id.toHexString() == request.eventTypeId);
        const startDate = new Date(request.startDate);
        const eventDataSourceIndex = EVENT_DATA_SOURCE_REGEX.findIndex((regex) => regex.test(request.sourceUri!));
        assert(eventDataSourceIndex > -1, new ClientError("Invalid source URI"));
        assert(startDate.toString() != "Invalid Date", new ClientError("Invalid date"));
        assert(
            request.eventTypeId == undefined || request.value == undefined, 
            new ClientError("Unable to define event type and value at same time for event.")
        );
        assert(
            request.eventTypeId != undefined || request.value != undefined, 
            new ClientError("One of event type and value must be defined for event.")
        );
        assert(request.eventTypeId == undefined || eventType, new ClientError("Invalid event type ID"));

        // Parse the source URI and ensure that it's unique
        const eventDataSource = EVENT_DATA_SOURCES[eventDataSourceIndex];
        const sourceId = getEventDataSourceId(eventDataSource, request.sourceUri);
        assert(sourceId, new ClientError("Invalid source URI"));

        const sourceUri = parseEventDataSourceUrl(eventDataSource, sourceId);
        const events = await this.eventColl.find({ troupeId }, { session }).toArray();
        const sourceUriExists = events.find(e => e.sourceUri == sourceUri) !== undefined;
        assert(!sourceUriExists, new ClientError("Source URI already exists for event."));
        
        // Populate new event
        const event: WithId<EventSchema> = {
            _id: new ObjectId(),
            troupeId,
            lastUpdated: new Date(),
            title: request.title,
            source: EVENT_DATA_SOURCES[eventDataSourceIndex],
            synchronizedSource: EVENT_DATA_SOURCES[eventDataSourceIndex],
            sourceUri,
            synchronizedSourceUri: sourceUri,
            startDate,
            eventTypeId: request.eventTypeId || undefined,
            eventTypeTitle: eventType?.title,
            value: request.value || eventType?.value as number,
            fieldToPropertyMap: {},
            synchronizedFieldToPropertyMap: {},
        };
        
        // Perform database update
        const dbUpdate = async (session: ClientSession) => {
            const insertedEvent = await this.eventColl.insertOne(event, { session });
            assert(insertedEvent.acknowledged, "Insert failed for event");
    
            // Update limits
            const limitsUpdated = await this.limitService.incrementTroupeLimits(
                limitContext, troupeId, { modifyOperationsLeft: -1, eventsLeft: -1 }, session
            );
            assert(limitsUpdated, new ClientError("Operation not within limits for this troupe"));
        }

        if(session) {
            await dbUpdate(session);
        } else {
            await this.client.withSession(s => s.withTransaction((session) => dbUpdate(session)));
        }
        return this.getEvent(event);
    }

    async createEvents(troupeId: string, requests: CreateEventRequest[]): Promise<PublicEvent[]> {
        const events: PublicEvent[] = [];
        
        // Create each event, ignoring the individual limit updates
        const limitContext = this.limitService.toggleIgnoreTroupeLimits(undefined, troupeId, true);
        await this.client.withSession(s => s.withTransaction(
            async (session) => {
                try {
                    for(const request of requests) {
                        events.push(await this.createEvent(troupeId, request, session, limitContext));
                    }
                } catch(e) {
                    this.limitService.toggleIgnoreTroupeLimits(limitContext, troupeId, false);
                    throw e;
                }
                
                // Update the aggregated limits
                this.limitService.toggleIgnoreTroupeLimits(limitContext, troupeId, false);
                const limitsUpdated = await this.limitService.incrementTroupeLimits(
                    limitContext, troupeId, { modifyOperationsLeft: -1, eventsLeft: requests.length * -1 }, session
                );
                assert(limitsUpdated, new ClientError("Operation not within limits for this troupe"));
            })
        );
        return events;
    }

    async getEvent(event: string | WithId<EventSchema>, troupeId?: string): Promise<PublicEvent> {
        assert(typeof event != "string" || troupeId != null, 
            new ClientError("Must have a troupe ID to retrieve event."));

        const eventObj = typeof event == "string" 
            ? await this.getEventSchema(troupeId!, event, true)
            : event;
        return toPublicEvent(eventObj, eventObj._id.toHexString());
    }

    async getEvents(troupeId: string): Promise<PublicEvent[]> {
        const events = await this.eventColl.find({ troupeId }).toArray();
        const parsedEvents = await Promise.all(events.map((e) => this.getEvent(e)));
        return parsedEvents;
    }

    async updateEvent(troupeId: string, eventId: string, request: UpdateEventRequest): Promise<PublicEvent> {
        const [ newEvent ] = await UpdateEventRequestBuilder.execute(troupeId, { eventId, ...request });
        return this.getEvent(newEvent);
    }

    async updateEvents(troupeId: string, request: BulkUpdateEventRequest): Promise<BulkUpdateEventResponse> {

        // Append the event ID to each request and execute the request builder
        const modifiedEvents = objectToArray<BulkUpdateEventRequest, UpdateEventRequest & { eventId: string }>(
            request, 
            (eventId, request) => ({ eventId: eventId as string, ...request })
        );
        const responses = await UpdateEventRequestBuilder.bulkExecute(troupeId, modifiedEvents);

        // Convert the array of responses back to the bulk event response
        const bulkResponse = await asyncArrayToObject<WithId<EventSchema>, BulkUpdateEventResponse>(
            responses,
            async (newEvent) => [newEvent._id.toHexString(), await this.getEvent(newEvent, troupeId)]
        );
        return bulkResponse;
    }

    async deleteEvent(troupeId: string, eventId: string, session?: ClientSession, limitContext?: LimitContext): Promise<void> {
        const troupe = await this.getTroupeSchema(troupeId, true, session);
        const event = await this.getEventSchema(troupeId, eventId, true, session);
        assert(!troupe.syncLock, new ClientError("Cannot delete event while sync is in progress"));

        // Update member points for types that the event is in data range for
        const $inc: UpdateOperator<MemberSchema, "$inc"> = {};

        Object.keys(troupe.pointTypes)
            .filter(pt => troupe.pointTypes[pt].startDate <= event.startDate && event.startDate <= troupe.pointTypes[pt].endDate)
            .forEach(pt => { $inc[`points.${pt}`] = -event.value });

        const membersToUpdate = await this.eventsAttendedColl
            .find({ troupeId, [`events.${eventId}`]: { $exists: true } }, { session }).toArray()
            .then(ea => ea.map(e => new ObjectId(e.memberId)));

        // Perform the database update
        const dbUpdate = async (session?: ClientSession) => {

            // Update audience membership points
            const updatePoints = await this.audienceColl.updateMany(
                { troupeId, _id: { $in: membersToUpdate }}, { $inc }, { session }
            );
            assert(updatePoints.matchedCount == updatePoints.modifiedCount, "Failed to update member points");
    
            // Remove event from events attended
            const updateEventsAttended = await this.eventsAttendedColl.updateMany(
                { troupeId },
                { $unset: { [`events.${eventId}`]: "" } },
                { session }
            );
            assert(updateEventsAttended.acknowledged, "Failed to update events attended");
    
            // Delete the event
            const deletedEvent = await this.eventColl.findOneAndDelete(
                { _id: new ObjectId(eventId), troupeId }, { session }
            );
            assert(deletedEvent, new ClientError("Failed to delete event"));
    
            // Update limits
            const limitsUpdated = await this.limitService.incrementTroupeLimits(
                limitContext, troupeId, { modifyOperationsLeft: -1, eventsLeft: 1 }, session
            );
            assert(limitsUpdated, new ClientError("Operation not within limits for this troupe"));
        }

        if(session) {
            await dbUpdate(session);
        } else {
            await this.client.withSession(s => s.withTransaction((session) => dbUpdate(session)));
        }
    }

    async deleteEvents(troupeId: string, eventIds: string[]): Promise<void> {

        // Delete the events
        const limitContext = this.limitService.toggleIgnoreTroupeLimits(undefined, troupeId, true);
        await this.client.withSession(s => s.withTransaction(
            async (session) => {
                try {
                    for(const eventId of eventIds) {
                        await this.deleteEvent(troupeId, eventId, session, limitContext);
                    }
                } catch(e) {
                    this.limitService.toggleIgnoreTroupeLimits(limitContext, troupeId, false);
                    throw e;
                }

                // Update limits
                this.limitService.toggleIgnoreTroupeLimits(limitContext, troupeId, false);
                const limitsUpdated = await this.limitService.incrementTroupeLimits(
                    limitContext, troupeId, { modifyOperationsLeft: -1, eventsLeft: eventIds.length }, session
                );
                assert(limitsUpdated, new ClientError("Operation not within limits for this troupe"));
            })
        );
    }

    async createEventType(troupeId: string, request: CreateEventTypeRequest, session?: ClientSession, limitContext?: LimitContext): Promise<EventType> {
        const troupe = await this.getTroupeSchema(troupeId, true, session);
        const existingSourceUris: string[] = [];
        troupe.eventTypes.forEach(et => existingSourceUris.push(...et.sourceFolderUris));

        // Ensure given source folder URIs are valid folders
        const sourceFolderUris: string[] = [];
        for(const uri of request.sourceFolderUris) {
            const eventFolderIndex = EVENT_FOLDER_DATA_SOURCE_REGEX.findIndex(r => r.test(uri));
            assert(eventFolderIndex > -1, new ClientError("Invalid source URI"));

            const eventFolder = EVENT_FOLDER_DATA_SOURCES[eventFolderIndex];
            const sourceId = getEventFolderDataSourceId(eventFolder, uri);
            assert(sourceId, new ClientError("Invalid source URI"));

            const sourceUri = parseEventFolderDataSourceUrl(eventFolder, sourceId);
            assert(
                !existingSourceUris.includes(sourceUri), 
                new ClientError("Source URI already exists for event type.")
            );
            existingSourceUris.push(sourceUri);
            sourceFolderUris.push(sourceUri);
        }

        // Populate new event type
        const type: WithId<EventTypeSchema> = {
            _id: new ObjectId(),
            lastUpdated: new Date(),
            title: request.title,
            value: request.value,
            sourceFolderUris,
            synchronizedSourceFolderUris: sourceFolderUris,
        };

        // Perform database update
        const dbUpdate = async (session?: ClientSession) => {

            // Insert into the troupe only if the max number of event types haven't been reached
            const insertResult = await this.troupeColl.updateOne(
                { _id: new ObjectId(troupeId), [`eventTypes.${MAX_EVENT_TYPES}`]: { $exists: false } },
                { $push: { eventTypes: type } },
                { session }
            );
            assert(insertResult.matchedCount == 1, new ClientError("Invalid troupe or max event types reached"));
            assert(insertResult.modifiedCount == 1, "Unable to create event type");
    
            // Update limits
            const limitsUpdated = await this.limitService.incrementTroupeLimits(
                limitContext, troupeId, { modifyOperationsLeft: -1, eventTypesLeft: -1 }, session
            );
            assert(limitsUpdated, new ClientError("Operation not within limits for this troupe"));
        }

        if(session) {
            await dbUpdate(session);
        } else {
            await this.client.withSession(s => s.withTransaction((session) => dbUpdate(session)));
        }
        return this.getEventType(type);
    }

    async createEventTypes(troupeId: string, requests: CreateEventTypeRequest[]): Promise<EventType[]> {
        const eventTypes: EventType[] = [];

        const limitContext = this.limitService.toggleIgnoreTroupeLimits(undefined, troupeId, true);
        await this.client.withSession(s => s.withTransaction(
            async (session) => {
                try {
                    for(const request of requests) {
                        eventTypes.push(await this.createEventType(troupeId, request, session, limitContext));
                    }
                } catch(e) {
                    this.limitService.toggleIgnoreTroupeLimits(limitContext, troupeId, false);
                    throw e;
                }

                this.limitService.toggleIgnoreTroupeLimits(limitContext, troupeId, false);
                const limitsUpdated = await this.limitService.incrementTroupeLimits(
                    limitContext, troupeId, { modifyOperationsLeft: -1, eventTypesLeft: requests.length * -1 }, session
                );
                assert(limitsUpdated, new ClientError("Operation not within limits for this troupe"));
            })
        );
        return eventTypes;
    }

    async getEventType(eventType: string | WithId<EventTypeSchema>, troupeId?: string, troupe?: WithId<TroupeSchema>): Promise<EventType> {
        assert(typeof eventType != "string" || troupeId != null, 
            new ClientError("Must have a troupe ID to retrieve event type."));
        
        const eventTypeObj = typeof eventType != "string" 
            ? eventType
            : troupe
            ? this.getEventTypeSchemaFromTroupe(troupe, eventType, true)
            : await this.getEventTypeSchema(troupeId!, eventType, true);
        return toEventType(eventTypeObj, eventTypeObj._id.toHexString());
    }

    async getEventTypes(troupeId: string): Promise<EventType[]> {
        const troupe = await this.getTroupeSchema(troupeId, true);

        const eventTypes = await Promise.all(
            troupe.eventTypes.map(et => this.getEventType(et))
        );
        return eventTypes;
    }

    async updateEventType(troupeId: string, eventTypeId: string, request: UpdateEventTypeRequest): Promise<EventType> {
        const [ newEventType ] = await UpdateEventTypeRequestBuilder.execute(troupeId, { eventTypeId, ...request });
        return this.getEventType(newEventType);
    }

    async updateEventTypes(troupeId: string, request: BulkUpdateEventTypeRequest): Promise<BulkUpdateEventTypeResponse> {
        const modifiedEventTypes = objectToArray<BulkUpdateEventTypeRequest, UpdateEventTypeRequest & { eventTypeId: string }>(
            request, 
            (eventTypeId, request) => ({ eventTypeId: eventTypeId as string, ...request })
        );
        const responses = await UpdateEventTypeRequestBuilder.bulkExecute(troupeId, modifiedEventTypes);

        const bulkResponse = await asyncArrayToObject<WithId<EventTypeSchema>, BulkUpdateEventTypeResponse>(
            responses,
            async (newEventType) => [newEventType._id.toHexString(), await this.getEventType(newEventType, troupeId)]
        );
        return bulkResponse;
    }

    async deleteEventType(troupeId: string, eventTypeId: string, session?: ClientSession, limitContext?: LimitContext): Promise<void> {
        const troupe = await this.getTroupeSchema(troupeId, true, session);
        assert(!troupe.syncLock, new ClientError("Cannot delete event type while sync is in progress"));

        // Update events attended
        const bulkEventsAttendedUpdate: AnyBulkWriteOperation<EventsAttendedBucketSchema>[] = [];
        const buckets = await this.eventsAttendedColl.find({ troupeId }).toArray();
        buckets.forEach(bucket => {
            const bucketUpdate: UpdateOperator<EventsAttendedBucketSchema, "$unset"> = {};
            for(const eventId in bucket.events) {
                if(bucket.events[eventId].typeId == eventTypeId) {
                    bucketUpdate[`events.${eventId}`] = "";
                }
            }
            bulkEventsAttendedUpdate.push({
                updateOne: {
                    filter: { _id: bucket._id },
                    update: { $unset: bucketUpdate }
                }
            });
        });

        const dbUpdate = async (session?: ClientSession) => {
            // Update events
            const updateEventResult = await this.eventColl.updateMany(
                { troupeId, eventTypeId },
                { $unset: { eventTypeId: "" } },
                { session }
            );
            assert(updateEventResult.acknowledged, "Failed to remove event type from events");
            
            if(bulkEventsAttendedUpdate.length > 0) {
                const updateEventsUpdate = await this.eventsAttendedColl.bulkWrite(bulkEventsAttendedUpdate, { session });
                assert(updateEventsUpdate.isOk(), "Failed to remove event type from events attended");
            }
    
            // Remove the event type from the troupe
            const deleteEventTypeResult = await this.troupeColl.updateOne(
                { _id: new ObjectId(troupeId) },
                { $pull: { eventTypes: { _id: new ObjectId(eventTypeId) }}},
                { session }
            );
            assert(deleteEventTypeResult.matchedCount, new ClientError("Invalid troupe ID"));
    
            // Update limits
            const limitsUpdated = await this.limitService.incrementTroupeLimits(
                limitContext, troupeId, { modifyOperationsLeft: -1, eventTypesLeft: 1 }, session
            );
            assert(limitsUpdated, new ClientError("Operation not within limits for this troupe"));
        }

        if(session) {
            await dbUpdate(session);
        } else {
            await this.client.withSession(s => s.withTransaction((session) => dbUpdate(session)));
        }
    }

    async deleteEventTypes(troupeId: string, eventTypeIds: string[]): Promise<void> {

        // Check if this operation is within the troupe's limits
        const withinLimits = await this.limitService.withinTroupeLimits(
            undefined, troupeId, { modifyOperationsLeft: -1, eventTypesLeft: eventTypeIds.length }
        );
        assert(withinLimits, new ClientError("Operation not within limits for this troupe"));

        const limitContext = this.limitService.toggleIgnoreTroupeLimits(undefined, troupeId, true);
        await this.client.withSession(s => s.withTransaction(
            async (session) => {
                try {
                    for(const eventTypeId of eventTypeIds) {
                        await this.deleteEventType(troupeId, eventTypeId, session, limitContext);
                    }
                } catch(e) {
                    this.limitService.toggleIgnoreTroupeLimits(limitContext, troupeId, false);
                    throw e;
                }

                // Update limits
                this.limitService.toggleIgnoreTroupeLimits(limitContext, troupeId, false);
                const limitsUpdated = await this.limitService.incrementTroupeLimits(
                    limitContext, troupeId, { modifyOperationsLeft: -1, eventTypesLeft: eventTypeIds.length }, session
                );
                assert(limitsUpdated, new ClientError("Operation not within limits for this troupe"));
            })
        );
    }

    async createMember(troupeId: string, request: CreateMemberRequest, session?: ClientSession, limitContext?: LimitContext): Promise<Member> {
        const troupe = await this.getTroupeSchema(troupeId, true, session);
        assert(!troupe.syncLock, new ClientError("Cannot create member while sync is in progress"));

        const properties: VariableMemberProperties = {};

        for(const prop in troupe.memberPropertyTypes) {
            assert(prop in request.properties, new ClientError("Missing required member property"));
            assert(verifyApiMemberPropertyType(request.properties[prop], troupe.memberPropertyTypes[prop]), 
                new ClientError("Invalid member property type"));

            properties[prop] = { value: request.properties[prop], override: true };
        }

        const points: VariableMemberPoints = {};
        for(const pt in troupe.pointTypes) { 
            points[pt] = 0;
        }

        const member: WithId<MemberSchema> = {
            _id: new ObjectId(),
            troupeId,
            lastUpdated: new Date(),
            properties: properties as BaseMemberProperties & VariableMemberProperties,
            points: points as BaseMemberPoints & VariableMemberPoints,
        }

        const dbUpdate = async (session?: ClientSession) => {
            const insertedMember = await this.audienceColl.insertOne(member, { session });
            assert(insertedMember.acknowledged, "Failed to insert member");
    
            // Update limits
            const limitsUpdated = await this.limitService.incrementTroupeLimits(
                limitContext, troupeId, { modifyOperationsLeft: -1, membersLeft: -1 }, session
            );
            assert(limitsUpdated, new ClientError("Operation not within limits for this troupe"));
        }

        if(session) {
            await dbUpdate(session);
        } else {
            await this.client.withSession(s => s.withTransaction((session) => dbUpdate(session)));
        }
        return this.getMember({ ...member, _id: member._id });
    }

    async createMembers(troupeId: string, requests: CreateMemberRequest[]): Promise<Member[]> {

        // Check if this operation is within the troupe's limits
        const withinLimits = await this.limitService.withinTroupeLimits(
            undefined, troupeId, { modifyOperationsLeft: -1, membersLeft: requests.length * -1 }
        );
        assert(withinLimits, new ClientError("Operation not within limits for this troupe"));

        const audience: Member[] = [];
        const limitContext = this.limitService.toggleIgnoreTroupeLimits(undefined, troupeId, true);
        await this.client.withSession(s => s.withTransaction(
            async (session) => {
                try {
                    for(const request of requests) {
                        audience.push(await this.createMember(troupeId, request, session, limitContext));
                    }
                } catch(e) {
                    this.limitService.toggleIgnoreTroupeLimits(limitContext, troupeId, false);
                    throw e;
                }

                // Update limits
                this.limitService.toggleIgnoreTroupeLimits(limitContext, troupeId, false);
                const limitsUpdated = await this.limitService.incrementTroupeLimits(
                    limitContext, troupeId, { modifyOperationsLeft: -1, membersLeft: requests.length * -1 }, session
                );
                assert(limitsUpdated, new ClientError("Operation not within limits for this troupe"));
            })
        );
        return audience;
    }

    async getMember(member: string | WithId<MemberSchema>, troupeId?: string): Promise<Member> {
        assert(typeof member != "string" || troupeId != null, 
            new ClientError("Must have a troupe ID to retrieve event."));

        const memberObj = typeof member == "string"
            ? await this.getMemberSchema(troupeId!, member, true)
            : member;
        return toMember(memberObj, memberObj._id.toHexString());
    }

    async getAttendee(member: string | WithId<AttendeeSchema>, troupeId?: string): Promise<Attendee> {
        assert(typeof member != "string" || troupeId != null, 
            new ClientError("Must have a troupe ID to retrieve event."));

        const attendeeObj = typeof member == "string"
            ? await this.getAttendeeSchema(troupeId!, member, true)
            : member;
        return toAttendee(attendeeObj, attendeeObj._id.toHexString());
    }

    async getAudience(troupeId: string): Promise<Member[]> {
        const audience = await this.audienceColl.find({ troupeId }).toArray();
        const newAudience = await Promise.all(audience.map(m => this.getMember(m)));
        return newAudience;
    }

    async getAttendees(troupeId: string): Promise<Attendee[]> {
        const audience = await this.getAttendeeSchemas(troupeId, true);
        const newAudience = await Promise.all(audience.map(m => this.getAttendee(m)));
        return newAudience;
    }

    async updateMember(troupeId: string, memberId: string, request: UpdateMemberRequest): Promise<Member> {
        const [ newMember ] = await UpdateMemberRequestBuilder.execute(troupeId, { memberId, ...request });
        return this.getMember(newMember);
    }

    async updateMembers(troupeId: string, request: BulkUpdateMemberRequest): Promise<BulkUpdateMemberResponse> {
        const modifiedAudience = objectToArray<BulkUpdateMemberRequest, UpdateMemberRequest & { memberId: string }>(
            request, 
            (memberId, request) => ({ memberId: memberId as string, ...request })
        );
        const responses = await UpdateMemberRequestBuilder.bulkExecute(troupeId, modifiedAudience);

        const bulkResponse = await asyncArrayToObject<WithId<MemberSchema>, BulkUpdateMemberResponse>(
            responses,
            async (newMember) => [newMember._id.toHexString(), await this.getMember(newMember, troupeId)]
        );
        return bulkResponse;
    }

    async deleteMember(troupeId: string, memberId: string, session?: ClientSession, limitContext?: LimitContext): Promise<void> {

        // Check if this operation is within the troupe's limits
        const withinLimits = await this.limitService.withinTroupeLimits(
            limitContext, troupeId, { modifyOperationsLeft: -1, membersLeft: 1 }, session
        );
        assert(withinLimits, new ClientError("Operation not within limits for this troupe"));

        const dbUpdate = async (session?: ClientSession) => {
            const deleteMember = await this.audienceColl.deleteOne(
                { _id: new ObjectId(memberId), troupeId }, { session }
            );
            const deleteBucket = await this.eventsAttendedColl.deleteMany(
                { troupeId, memberId }, { session }
            );
            assert(deleteMember.acknowledged && deleteBucket.acknowledged, "Failed to delete member data");
    
            // Update limits
            const limitsUpdated = await this.limitService.incrementTroupeLimits(
                limitContext, troupeId, { modifyOperationsLeft: -1, membersLeft: 1 }, session
            );
            assert(limitsUpdated, new ClientError("Operation not within limits for this troupe"));
        }
        
        if(session) {
            await dbUpdate(session);
        } else {
            await this.client.withSession(s => s.withTransaction((session) => dbUpdate(session)));
        }
    }

    async deleteMembers(troupeId: string, memberIds: string[]): Promise<void> {

        // Check if this operation is within the troupe's limits
        const withinLimits = await this.limitService.withinTroupeLimits(
            undefined, troupeId, { modifyOperationsLeft: -1, membersLeft: memberIds.length }
        );
        assert(withinLimits, new ClientError("Operation not within limits for this troupe"));

        const limitContext = this.limitService.toggleIgnoreTroupeLimits(undefined, troupeId, true);
        await this.client.withSession(s => s.withTransaction(
            async (session) => {
                try {
                    for(const memberId of memberIds) {
                        await this.deleteMember(troupeId, memberId, session);
                    }
                } catch(e) {
                    this.limitService.toggleIgnoreTroupeLimits(limitContext, troupeId, false);
                    throw e;
                }

                // Update limits
                this.limitService.toggleIgnoreTroupeLimits(limitContext, troupeId, false);
                const limitsUpdated = await this.limitService.incrementTroupeLimits(
                    limitContext, troupeId, { modifyOperationsLeft: -1, membersLeft: memberIds.length }, session
                );
                assert(limitsUpdated, new ClientError("Operation not within limits for this troupe"));
            }
        ));
    }

    async initiateSync(troupeId: string): Promise<void> {
        await this.client.withSession(s => s.withTransaction(
            async (session) => {
                const limitsUpdated = await this.limitService.incrementTroupeLimits(
                    undefined, troupeId, { manualSyncsLeft: -1 }, session
                );
                assert(limitsUpdated, new ClientError("Operation not within limits for this troupe"));

                const troupe = await this.getTroupeSchema(troupeId, true, session);
                assert(!troupe.syncLock, new ClientError("Sync is already in progress"));
                await this.syncService.addToSyncQueue({ troupeId });
            }
        ));
    }
}
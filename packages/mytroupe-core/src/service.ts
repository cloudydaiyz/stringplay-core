import assert from "assert";
import { initTroupeSheet } from "./cloud/gcp";
import { MyTroupeCore } from "./index";
import { CreateTroupeSchema } from "./types/service-types";
import { ObjectId } from "mongodb";

// Additional functionality for other backend services
export class MyTroupeService extends MyTroupeCore {
    constructor() { super() }

    async refresh() {
        const { TroupeLogRefreshService } = await import("./refresh");
        const refreshService = new TroupeLogRefreshService();
        await refreshService.ready;

        // refreshService.discoverEvents();
        // refreshService.updateAudience();
        // refreshService.refreshLogSheet();
        // refreshService.prepareDatabaseUpdate();

        // delete members that are no longer in the source folder & have no overridden properties
    }

    async createTroupe(req: CreateTroupeSchema) {
        const logSheetUri = await initTroupeSheet(req.name).then(res => res.data.id);
        assert(logSheetUri, "Failed to create log sheet");

        return this.client.startSession().withTransaction(async () => {
            const lastUpdated = new Date();
            const troupe = await this.troupeColl.insertOne({
                ...req,
                lastUpdated,
                logSheetUri,
                eventTypes: [],
                memberProperties: {
                    "First Name": "string!",
                    "Middle Name": "string?",
                    "Last Name": "string!",
                    "Member ID": "string!",
                    "Email": "string!",
                    "Birthday": "date!",
                },
                pointTypes: {
                    "Total": {
                        startDate: new Date(0),
                        endDate: new Date(3000000000000),
                    },
                },
                refreshLock: false,
            });
            assert(troupe.insertedId, "Failed to create troupe");
    
            const dashboard = await this.dashboardColl.insertOne({
                troupeId: troupe.insertedId.toHexString(),
                lastUpdated,
                totalMembers: 0,
                totalEvents: 0,
                avgPointsPerEvent: 0,
                avgAttendeesPerEvent: 0,
                avgAttendeesPerEventType: [],
                attendeePercentageByEventType: [],
                eventPercentageByEventType: [],
                upcomingBirthdays: {
                    frequency: "monthly",
                    desiredFrequency: "monthly",
                    members: [],
                },
            });
            assert(dashboard.insertedId, "Failed to create dashboard");
            return troupe.insertedId;
        });
    }

    async deleteTroupe(troupeId: string) {
        return this.client.startSession().withTransaction(async () => {
            return Promise.all([
                this.troupeColl.deleteOne({ _id: new ObjectId(troupeId) }),
                this.dashboardColl.deleteOne({ troupeId }),
                this.audienceColl.deleteMany({ troupeId }),
                this.eventColl.deleteMany({ troupeId })
            ]).then((res) => {
                assert(res.every((r) => r.acknowledged), "Failed to fully delete troupe");
                console.log(res.reduce((deletedCount, r) => deletedCount + r.deletedCount, 0));
            });
        });
    }
}
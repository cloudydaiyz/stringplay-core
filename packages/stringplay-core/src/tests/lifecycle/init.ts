import { BaseDbService } from "../../services/base";
import { StringplayApiService } from "../../services/api";
import { SystemSetupConfig, defaultConfig, populateConfig } from "../../util/server/test-config";
import { cleanDbConnections, cleanLogs, startDb, stopDb } from "../../util/server/resources";

/**
 * Setup the database with the given configuration, opting out of interaction with
 * external services (Google Sheets, Google Forms, etc.)
 */
async function dbSetup(config: SystemSetupConfig) {
    const { testTroupes, testEvents, testAudience, testEventsAttended, testDashboards } = populateConfig(config);

    const db = await BaseDbService.create();
    const operations: Promise<any>[] = [];
    if(testTroupes.length > 0) operations.push(db.troupeColl.insertMany(testTroupes));
    if(testEvents.length > 0) operations.push(db.eventColl.insertMany(testEvents));
    if(testAudience.length > 0) operations.push(db.audienceColl.insertMany(testAudience));
    if(testEventsAttended.length > 0) operations.push(db.eventsAttendedColl.insertMany(testEventsAttended));
    if(testDashboards.length > 0) operations.push(db.dashboardColl.insertMany(testDashboards));

    await Promise.all(operations).then(() => db.close());
    return config;
}

export default function () {

    // Start the server
    beforeAll(async () => {
        await startDb();

        // Test that the default config is working properly
        const config = await dbSetup(defaultConfig);
        const api = await StringplayApiService.create();
        
        await Promise.all([
            expect(api.getEvents(config.troupes!["A"].id!)).resolves.toHaveLength(7),
            expect(api.getAudience(config.troupes!["A"].id!)).resolves.toHaveLength(5),
        ]);
        api.close();
    });
    
    // Delete all data from the database
    afterEach(async () => {
        const cleanupService = await BaseDbService.create();

        // Delete all collections
        await Promise.all([
            cleanupService.troupeColl.deleteMany({}),
            cleanupService.dashboardColl.deleteMany({}),
            cleanupService.eventColl.deleteMany({}),
            cleanupService.audienceColl.deleteMany({}),
            cleanupService.eventsAttendedColl.deleteMany({}),
        ]);
        await cleanDbConnections();
    });

    // Stop the server
    afterAll(async () => {
        await cleanLogs();
        await stopDb();
    });

    return { dbSetup };
};
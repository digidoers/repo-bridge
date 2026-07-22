import { prisma } from "@repo-sync/db";
async function main() {
    const job = await prisma.syncJob.findUnique({
        where: { id: "3a564a90-fcce-4946-aaa4-e45b34b026ad" },
        include: {
            pushEvent: {
                include: { repository: true }
            },
            targetRepo: true,
            files: true
        }
    });
    if (!job) {
        console.error("Job not found");
        return;
    }
    console.log("Job ID:", job.id);
    console.log("Status:", job.status);
    console.log("baseSha:", job.pushEvent.baseSha);
    console.log("commitSha:", job.pushEvent.commitSha);
    console.log("errorMessage:", job.errorMessage);
    console.log("Files count in DB:", job.files.length);
    console.log("Files:", job.files.map((f) => f.filePath).slice(0, 10));
}
main().catch(console.error).finally(() => prisma.$disconnect());
//# sourceMappingURL=test-job-check.js.map
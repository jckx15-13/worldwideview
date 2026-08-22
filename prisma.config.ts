import fs from "fs";
import path from "path";

let dbUrl = process.env.DATABASE_URL;

if (!dbUrl) {
    try {
        const envLocalPath = path.resolve(process.cwd(), ".env");
        if (fs.existsSync(envLocalPath)) {
            const envContent = fs.readFileSync(envLocalPath, "utf8");
            const match = envContent.match(/^DATABASE_URL=["']?(.*?)["']?$/m);
            if (match) {
                dbUrl = match[1].trim();
            }
        }
        if (!dbUrl) {
            const envPath = path.resolve(process.cwd(), ".env");
            if (fs.existsSync(envPath)) {
                const envContent = fs.readFileSync(envPath, "utf8");
                const match = envContent.match(/^DATABASE_URL=["']?(.*?)["']?$/m);
                if (match) {
                    dbUrl = match[1].trim();
                }
            }
        }
    } catch (e) {
        // Ignore
    }
}

function deriveShadowUrl(url: string | undefined): string | undefined {
    if (!url) return url;
    // Match the LAST path segment before an optional query string.
    // This is more robust than the previous pattern which could match an
    // intermediate segment on URLs with unusual structure.
    const match = url.match(/^(.+\/)([^/?]+)(\?.*)?$/);
    if (!match) {
        console.warn(
            "[prisma.config] Could not derive shadow database URL from DATABASE_URL. " +
            "Set SHADOW_DATABASE_URL explicitly if prisma db push fails."
        );
        return url;
    }
    return `${match[1]}${match[2]}_shadow${match[3] || ""}`;
}

export default {
    datasource: {
        url: dbUrl,
        shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL || deriveShadowUrl(dbUrl),
    },
};
declare global {
    interface Window {
        /**
         * NOTE: nothing in this repository ever assigns `window.ENV`.
         * Verified 2026-08-16 by repo-wide grep. Until something does, the
         * browser branch below no-ops and `global-error.tsx` reports nothing.
         * Wiring it up is a deliberate decision, not an oversight to "fix"
         * casually — see the scheme check in `resolveEndpoint`.
         */
        ENV?: {
            NEXT_PUBLIC_DIAGNOSTIC_ENGINE_URL?: string;
        };
    }
}

export interface DiagnosticReport {
    message: string;
    severity?: "debug" | "info" | "warn" | "error" | "critical" | "fatal";
    category?: string;
    stack?: string;
    metadata?: Record<string, unknown>;
}

/**
 * Substrings, not exact keys. The previous exact-match set let `apiKey`,
 * `accessToken`, `authorization`, `cookie`, `privateKey` and `jwt` through
 * untouched while still stamping the payload `sanitized: true`.
 */
const SENSITIVE_PATTERNS = [
    "key", "token", "auth", "password", "secret", "credential",
    "cookie", "session", "jwt", "signature", "bearer",
];

const BACKOFF_DURATION_MS = 60000;
const REQUEST_TIMEOUT_MS = 5000;
const MAX_REDACTION_DEPTH = 6;

let lastFailureTime = 0;

function generateId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).slice(2, 8);
    return `wwv-${timestamp}-${random}`;
}

function isSensitiveKey(key: string): boolean {
    const lower = key.toLowerCase();
    return SENSITIVE_PATTERNS.some((p) => lower.includes(p));
}

function redactString(str: string): string {
    if (typeof str !== "string") return str;
    return str
        .replace(/[?&]([a-z_]*(?:token|key|secret|password|auth|credential)[a-z_]*)=[^&\s]+/gi, "$1=[REDACTED]")
        .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
        .replace(/Basic\s+[^\s]+/gi, "Basic [REDACTED]");
}

/**
 * Recurses into nested objects and arrays, and applies `redactString` to string
 * values. The previous implementation did neither, so a secret one level down —
 * or a bearer token inside an otherwise innocuous string — survived intact.
 */
function redactValue(value: unknown, depth = 0): unknown {
    if (depth >= MAX_REDACTION_DEPTH) return "[TRUNCATED]";
    if (typeof value === "string") return redactString(value);
    if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = isSensitiveKey(k) ? "[REDACTED]" : redactValue(v, depth + 1);
        }
        return out;
    }
    return value;
}

export function redactMetadata(obj: Record<string, unknown>): Record<string, unknown> {
    if (!obj || typeof obj !== "object") return {};
    return redactValue(obj) as Record<string, unknown>;
}

/**
 * Only `http:`/`https:` absolute URLs are accepted. On the browser side the
 * destination comes from mutable global state, so without this check any script
 * able to set `window.ENV` could redirect every future report — stack traces
 * included — to a host of its choosing.
 */
function resolveEndpoint(): string | null {
    const raw = typeof window !== "undefined"
        ? window.ENV?.NEXT_PUBLIC_DIAGNOSTIC_ENGINE_URL
        : process.env.DIAGNOSTIC_ENGINE_URL;
    if (!raw) return null;
    try {
        const parsed = new URL(raw);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
        return `${parsed.origin}/api/diagnostics/ingest`;
    } catch {
        return null;
    }
}

/** Fire-and-forget. Never throws. No-ops when the engine URL is unset or invalid. */
export function reportToDiagnosticEngine(report: DiagnosticReport, source: string): void {
    const endpoint = resolveEndpoint();
    if (!endpoint) return;
    if (Date.now() - lastFailureTime < BACKOFF_DURATION_MS) return;

    const entry = {
        id: generateId(),
        timestamp: Date.now(),
        severity: report.severity || "error",
        category: report.category || "runtime",
        message: redactString(report.message),
        stack: report.stack ? redactString(report.stack) : undefined,
        source,
        metadata: report.metadata ? redactMetadata(report.metadata) : undefined,
        sanitized: true,
    };

    try {
        const payload = JSON.stringify(entry);
        if (typeof window !== "undefined") {
            // A `false` return means the payload was rejected (size cap, or no
            // beacon support). Previously discarded, so backoff never engaged.
            const queued = navigator.sendBeacon?.(endpoint, payload);
            if (!queued) lastFailureTime = Date.now();
        } else {
            fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: payload,
                // fetch resolves on 4xx/5xx, so a dead engine never tripped the
                // backoff. Check `ok` explicitly, and bound the request.
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            })
                .then((res) => {
                    if (!res.ok) lastFailureTime = Date.now();
                })
                .catch(() => {
                    lastFailureTime = Date.now();
                });
        }
    } catch {
        lastFailureTime = Date.now();
    }
}

/** Test-only: clears the module-level backoff so cases do not bleed into each other. */
export function __resetBackoffForTests(): void {
    lastFailureTime = 0;
}

type LogLevel = "info" | "warn" | "error";

type LogFields = Record<string, unknown>;

function normalizeFields(fields: LogFields): LogFields {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
}

function writeLog(level: LogLevel, event: string, fields: LogFields): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...normalizeFields(fields),
  };
  console[level](JSON.stringify(entry));
}

export function logInfo(event: string, fields: LogFields): void {
  writeLog("info", event, fields);
}

export function logWarn(event: string, fields: LogFields): void {
  writeLog("warn", event, fields);
}

export function logError(event: string, fields: LogFields): void {
  writeLog("error", event, fields);
}

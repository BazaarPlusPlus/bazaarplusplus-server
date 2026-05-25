type LogLevel = "info" | "warn" | "error";

type LogFields = Record<string, unknown>;

type ParsedErrorPayload = {
  errorCode: string | null;
  reason: string | null;
  detail: string | null;
};

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

export function parseErrorBody(body: string): ParsedErrorPayload {
  if (!body.trim()) {
    return { errorCode: null, reason: null, detail: null };
  }

  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return {
      errorCode:
        typeof parsed.error === "string" && parsed.error.trim()
          ? parsed.error.trim()
          : null,
      reason:
        typeof parsed.reason === "string" && parsed.reason.trim()
          ? parsed.reason.trim()
          : null,
      detail:
        typeof parsed.detail === "string" && parsed.detail.trim()
          ? parsed.detail.trim()
          : typeof parsed.message === "string" && parsed.message.trim()
            ? parsed.message.trim()
            : null,
    };
  } catch {
    return { errorCode: null, reason: null, detail: null };
  }
}

export async function logResponseWarning(
  event: string,
  response: Response,
  fields: LogFields,
): Promise<void> {
  const body = await response.clone().text();
  const parsed = parseErrorBody(body);
  logWarn(event, {
    ...fields,
    status: response.status,
    error_code: parsed.errorCode,
    validation_reason: parsed.reason,
    detail: parsed.detail,
  });
}


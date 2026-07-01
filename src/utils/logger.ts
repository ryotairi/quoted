export type LogLevel = "debug" | "info" | "warn" | "error";
type Method = "debug" | "info" | "success" | "warn" | "error" | "fail";

const levels: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
let currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";

export function setLogLevel(level: LogLevel) {
  currentLevel = level;
}
const visible = (threshold: number) => threshold >= levels[currentLevel];

const useColor =
  process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
const paint = (code: string, s: string) =>
  useColor ? `\x1b[${code}m${s}\x1b[0m` : s;

const META: Record<
  Method,
  { label: string; code: string; bg: string; threshold: number }
> = {
  debug: { label: "DEBUG", code: "90", bg: "100", threshold: levels.debug }, // grey bg
  info: { label: "INFO", code: "36", bg: "44", threshold: levels.info }, // blue bg
  success: { label: "SUCCESS", code: "32", bg: "42", threshold: levels.info }, // green bg
  warn: { label: "WARN", code: "33", bg: "43", threshold: levels.warn }, // yellow bg
  error: { label: "ERR", code: "31", bg: "41", threshold: levels.error }, // red bg
  fail: { label: "FAIL", code: "91", bg: "101", threshold: levels.error }, // bright red bg
};
const LABEL_WIDTH = 7; // widest label: 'SUCCESS'
const MODULE_WIDTH = 7; // align the '>' across all module names

function center(s: string, width: number): string {
  if (s.length >= width) return s;
  const total = width - s.length;
  const left = Math.floor(total / 2);
  return " ".repeat(left) + s + " ".repeat(total - left);
}

// Deterministic colour per module so each subsystem keeps a stable hue.
const MODULE_CODES = ["36", "35", "34", "32", "33", "95", "94", "96"];
const moduleColor = new Map<string, string>();
function colorFor(mod: string): string {
  let c = moduleColor.get(mod);
  if (!c) {
    let h = 0;
    for (let i = 0; i < mod.length; i++) h = (h * 31 + mod.charCodeAt(i)) | 0;
    c = MODULE_CODES[Math.abs(h) % MODULE_CODES.length];
    moduleColor.set(mod, c);
  }
  return c;
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// Pull an optional { status } / { code } trailer off the args so it can render
// as "(STATUS CODE: …)" instead of being printed as a raw object.
function extractStatus(args: any[]): { status?: number | string; rest: any[] } {
  if (args.length) {
    const last = args[args.length - 1];
    if (last && typeof last === "object" && !Array.isArray(last)) {
      const s = (last as any).status ?? (last as any).code;
      if (typeof s === "number" || typeof s === "string") {
        return { status: s, rest: args.slice(0, -1) };
      }
    }
  }
  return { rest: args };
}

// Format: {TIME} |{module}  > [{ LEVEL }] (STATUS CODE: {}) | {MESSAGE} <|
function build(method: Method, mod: string, args: any[]): any[] {
  const m = META[method];
  const { status, rest } = extractStatus(args);
  const time = paint("90", timestamp());
  // Pad the module name with plain spaces so the '>' lands at a fixed column.
  const pad = " ".repeat(Math.max(0, MODULE_WIDTH - mod.length));
  const moduleTag = `${paint("90", "|")}${paint(colorFor(mod), mod)}${pad}${paint("90", ">")}`;
  // Level badge: white text, centered, on a coloured background.
  const level = paint(`97;1;${m.bg}`, `[${center(m.label, LABEL_WIDTH)}]`);
  const statusTag =
    status !== undefined
      ? ` ${paint("90", "(STATUS CODE:")} ${paint(m.code, String(status))}${paint("90", ")")}`
      : "";
  const head = `${time} ${moduleTag} ${level}${statusTag} ${paint("90", "|")}`;
  return [head, ...rest, paint("90", "<|")];
}

export function createLogger(mod: string) {
  const emit = (method: Method, out: (...a: any[]) => void, args: any[]) => {
    if (visible(META[method].threshold)) out(...build(method, mod, args));
  };
  return {
    debug: (...a: any[]) => emit("debug", console.log, a),
    info: (...a: any[]) => emit("info", console.log, a),
    success: (...a: any[]) => emit("success", console.log, a),
    warn: (...a: any[]) => emit("warn", console.warn, a),
    error: (...a: any[]) => emit("error", console.error, a),
    fail: (...a: any[]) => emit("fail", console.error, a),
  };
}

export type Logger = ReturnType<typeof createLogger>;

export const log = createLogger("main");

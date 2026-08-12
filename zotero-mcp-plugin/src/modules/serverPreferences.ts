import { config } from "../../package.json";
import { generateSecureIdentifier } from "../utils/security";

declare let ztoolkit: ZToolkit;

const PREFS_PREFIX = config.prefsPrefix;
const MCP_SERVER_PORT = `${PREFS_PREFIX}.mcp.server.port`;
const MCP_SERVER_ENABLED = `${PREFS_PREFIX}.mcp.server.enabled`;
const MCP_SERVER_ALLOW_REMOTE = `${PREFS_PREFIX}.mcp.server.allowRemote`;
const MCP_SERVER_AUTH_TOKEN = `${PREFS_PREFIX}.mcp.server.authToken`;
const MCP_SERVER_REQUIRE_AUTH = `${PREFS_PREFIX}.mcp.server.requireAuth`;

type PreferenceObserver = (name: string) => void;

class ServerPreferences {
  private observers: PreferenceObserver[] = [];
  private observerID: symbol | null = null;
  private monitorInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // 进程诊断
    try {
      const runtime = Cc["@mozilla.org/xre/app-info;1"]?.getService(Ci.nsIXULRuntime) as any;
      const pid = runtime?.processID;
      const ptype = runtime?.processType;
      if (typeof ztoolkit !== 'undefined') {
        ztoolkit.log(`[ServerPreferences] Constructor called - PID: ${pid}, processType: ${ptype}`);
      }
    } catch (e) { /* ignore */ }
    this.initializeDefaults();
    this.register();
  }

  private initializeDefaults(): void {
    const defaults: Array<[string, unknown]> = [
      [MCP_SERVER_PORT, 23120],
      [MCP_SERVER_ENABLED, false],
      [MCP_SERVER_ALLOW_REMOTE, false],
      [MCP_SERVER_AUTH_TOKEN, ''],
      [MCP_SERVER_REQUIRE_AUTH, false],
    ];

    for (const [key, value] of defaults) {
      try {
        const current = Zotero.Prefs.get(key, true);
        if (current === undefined || current === null) Zotero.Prefs.set(key, value as any, true);
      } catch (error) {
        ztoolkit.log(`[ServerPreferences] Failed to initialize ${key}: ${error}`, 'error');
      }
    }

    if (this.isRemoteAccessAllowed()) this.ensureAuthToken();
  }

  private logDiagnosticInfo(): void {
    // Intentionally empty in production: never enumerate or log preference values.
  }

  private startPreferenceMonitoring(): void {
    // Intentionally disabled in production: the former monitor logged all preferences.
  }

  public getPort(): number {
    const DEFAULT_PORT = 23120;
    try {
      const port = Zotero.Prefs.get(MCP_SERVER_PORT, true);

      // 添加调试日志
      if (typeof Zotero !== "undefined" && Zotero.debug) {
        Zotero.debug(
          `[ServerPreferences] Raw port value from prefs: ${port} (type: ${typeof port})`,
        );
      }

      // 确保返回有效的端口号
      if (port === undefined || port === null || isNaN(Number(port))) {
        if (typeof Zotero !== "undefined" && Zotero.debug) {
          Zotero.debug(
            `[ServerPreferences] Port value invalid, using default: ${DEFAULT_PORT}`,
          );
        }
        return DEFAULT_PORT;
      }

      return Number(port);
    } catch (error) {
      // 如果偏好设置系统还未初始化或发生错误，返回默认值
      if (typeof Zotero !== "undefined" && Zotero.debug) {
        Zotero.debug(
          `[ServerPreferences] Error getting port: ${error}. Using default: ${DEFAULT_PORT}`,
        );
      }
      return DEFAULT_PORT;
    }
  }

  public isServerEnabled(): boolean {
    const DEFAULT_ENABLED = false;
    try {
      const enabled = Zotero.Prefs.get(MCP_SERVER_ENABLED, true);

      ztoolkit.log(`[ServerPreferences] Reading ${MCP_SERVER_ENABLED}: ${enabled} (type: ${typeof enabled})`);

      // 确保返回有效的布尔值
      if (enabled === undefined || enabled === null) {
        ztoolkit.log(`[ServerPreferences] Server enabled value invalid, using default: ${DEFAULT_ENABLED}`);
        return DEFAULT_ENABLED;
      }

      const result = Boolean(enabled);
      ztoolkit.log(`[ServerPreferences] isServerEnabled returning: ${result}`);
      return result;
    } catch (error) {
      ztoolkit.log(`[ServerPreferences] Error getting server enabled status: ${error}. Using default: ${DEFAULT_ENABLED}`);
      return DEFAULT_ENABLED;
    }
  }

  public isRemoteAccessAllowed(): boolean {
    const DEFAULT_ALLOW_REMOTE = false;
    try {
      const allowRemote = Zotero.Prefs.get(MCP_SERVER_ALLOW_REMOTE, true);

      if (allowRemote === undefined || allowRemote === null) {
        return DEFAULT_ALLOW_REMOTE;
      }

      return Boolean(allowRemote);
    } catch (error) {
      ztoolkit.log(`[ServerPreferences] Error getting allow remote status: ${error}. Using default: ${DEFAULT_ALLOW_REMOTE}`);
      return DEFAULT_ALLOW_REMOTE;
    }
  }

  public getAuthToken(): string {
    try {
      return String(Zotero.Prefs.get(MCP_SERVER_AUTH_TOKEN, true) || '').trim();
    } catch {
      return '';
    }
  }

  public ensureAuthToken(): string {
    let token = this.getAuthToken();
    if (!token || token.length < 32) {
      token = generateSecureIdentifier("");
      Zotero.Prefs.set(MCP_SERVER_AUTH_TOKEN, token, true);
    }
    return token;
  }

  public isAuthRequired(): boolean {
    if (this.isRemoteAccessAllowed()) return true;
    try {
      return Zotero.Prefs.get(MCP_SERVER_REQUIRE_AUTH, true) === true;
    } catch {
      return false;
    }
  }

  public addObserver(observer: PreferenceObserver): void {
    this.observers.push(observer);
  }

  public removeObserver(observer: PreferenceObserver): void {
    const index = this.observers.indexOf(observer);
    if (index > -1) {
      this.observers.splice(index, 1);
    }
  }

  private register(): void {
    try {
      // Register observer for the enabled preference only
      if (typeof ztoolkit !== 'undefined') {
        ztoolkit.log(`[ServerPreferences] Registering observer for: ${MCP_SERVER_ENABLED}`);
      }
      
      this.observerID = Zotero.Prefs.registerObserver(
        MCP_SERVER_ENABLED,
        (name: string) => {
          if (typeof ztoolkit !== 'undefined') {
            ztoolkit.log(`[ServerPreferences] Observer triggered for: ${name}`);
          }
          this.observers.forEach((observer) => observer(name));
        },
      );
      
      if (typeof ztoolkit !== 'undefined') {
        ztoolkit.log(`[ServerPreferences] Observer registered with ID: ${this.observerID?.toString()}`);
      }
    } catch (error) {
      if (typeof ztoolkit !== 'undefined') {
        ztoolkit.log(`[ServerPreferences] Error registering observer: ${error}`, 'error');
      }
    }
  }

  public unregister(): void {
    // Clear the monitoring interval
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
      ztoolkit.log(`[ServerPreferences] Monitor interval cleared`);
    }

    if (this.observerID) {
      Zotero.Prefs.unregisterObserver(this.observerID);
      this.observerID = null;
    }
    this.observers = [];
    ztoolkit.log(`[ServerPreferences] Unregistered`);
  }
}

export const serverPreferences = new ServerPreferences();

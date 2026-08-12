import { config } from "../../package.json";
import { generateSecureIdentifier } from "../utils/security";

declare let ztoolkit: ZToolkit;

const PREFS_PREFIX = config.prefsPrefix;
const MCP_SERVER_PORT = `${PREFS_PREFIX}.mcp.server.port`;
const MCP_SERVER_ENABLED = `${PREFS_PREFIX}.mcp.server.enabled`;
const MCP_SERVER_ALLOW_REMOTE = `${PREFS_PREFIX}.mcp.server.allowRemote`;
const MCP_SERVER_AUTH_TOKEN = `${PREFS_PREFIX}.mcp.server.authToken`;
const MCP_SERVER_REQUIRE_AUTH = `${PREFS_PREFIX}.mcp.server.requireAuth`;

/**
 * 会影响 MCP 监听地址/端口/鉴权的偏好全名。
 * 导出给 hooks 使用，避免在多处硬编码同一串字符串而写错。
 */
export const SERVER_LISTENER_PREFS = {
  enabled: MCP_SERVER_ENABLED,
  port: MCP_SERVER_PORT,
  allowRemote: MCP_SERVER_ALLOW_REMOTE,
  requireAuth: MCP_SERVER_REQUIRE_AUTH,
} as const;

type PreferenceObserver = (name: string) => void;

class ServerPreferences {
  private observers: PreferenceObserver[] = [];
  private observerIDs: symbol[] = [];
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
    // 影响监听地址/端口的偏好，任何一个变化都要让服务器重新对齐配置。
    // 之前只注册了 enabled，改端口和开关远程访问都不会触发任何动作。
    const watched = [
      MCP_SERVER_ENABLED,
      MCP_SERVER_PORT,
      MCP_SERVER_ALLOW_REMOTE,
      MCP_SERVER_REQUIRE_AUTH,
    ];

    for (const prefName of watched) {
      try {
        if (typeof ztoolkit !== 'undefined') {
          ztoolkit.log(`[ServerPreferences] Registering observer for: ${prefName}`);
        }

        // 两处必须显式处理，否则 observer 形同虚设：
        // 1. 第三个参数 global 必须为 true。为 false 时 Zotero 会把名字挂到
        //    extensions.zotero. 分支下，我们传的已经是全名，会变成
        //    extensions.zotero.extensions.zotero...，永远不会被触发。
        // 2. 回调收到的第一个参数是偏好的“新值”，不是偏好名。原实现把它当
        //    名字与全名做字符串比较，即使触发也永远匹配不上。这里改为闭包捕获
        //    已知的 prefName 传给下游，回调参数只用于日志。
        const observerID = Zotero.Prefs.registerObserver(
          prefName,
          (newValue: unknown) => {
            if (typeof ztoolkit !== 'undefined') {
              ztoolkit.log(
                `[ServerPreferences] Observer triggered for ${prefName} (new value type: ${typeof newValue})`,
              );
            }
            this.observers.forEach((observer) => {
              try {
                observer(prefName);
              } catch (callbackError) {
                if (typeof ztoolkit !== 'undefined') {
                  ztoolkit.log(
                    `[ServerPreferences] Observer callback failed for ${prefName}: ${callbackError}`,
                    'error',
                  );
                }
              }
            });
          },
          true,
        );

        this.observerIDs.push(observerID);
      } catch (error) {
        if (typeof ztoolkit !== 'undefined') {
          ztoolkit.log(
            `[ServerPreferences] Error registering observer for ${prefName}: ${error}`,
            'error',
          );
        }
      }
    }

    if (typeof ztoolkit !== 'undefined') {
      ztoolkit.log(`[ServerPreferences] Registered ${this.observerIDs.length} preference observers`);
    }
  }

  public unregister(): void {
    // Clear the monitoring interval
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
      ztoolkit.log(`[ServerPreferences] Monitor interval cleared`);
    }

    for (const observerID of this.observerIDs) {
      try {
        Zotero.Prefs.unregisterObserver(observerID);
      } catch (error) {
        ztoolkit.log(`[ServerPreferences] Error unregistering observer: ${error}`, 'error');
      }
    }
    this.observerIDs = [];
    this.observers = [];
    ztoolkit.log(`[ServerPreferences] Unregistered`);
  }
}

export const serverPreferences = new ServerPreferences();

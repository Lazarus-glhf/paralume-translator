import { SAFE_ERROR_MESSAGES, type ErrorCode } from "../shared/errors";

export type UiLanguageSetting = "system" | "zh-CN" | "en";
export type UiLocale = Exclude<UiLanguageSetting, "system">;

const EN_MESSAGES = {
  "content.alreadyUpToDate": "Translations are already up to date.",
  "content.cancelled":
    "Translation was cancelled because translations were cleared.",
  "content.clearEmpty": "There are no translations to clear.",
  "content.clearEmptyCancelled":
    "There were no rendered translations to clear. Cancellation was requested for pending translation work.",
  "content.cleared": "Cleared {count} translations.",
  "content.clearedAndCancelled":
    "Cleared {count} translations and requested cancellation of pending translation work.",
  "content.noEligible": "No eligible readable blocks were found on this page.",
  "content.noFit": "No readable blocks fit within the per-page request limit.",
  "content.noFitOmitted":
    "No readable blocks fit within the per-page request limit; {omitted} were skipped.",
  "content.omitted":
    "{count} additional readable blocks were skipped by the per-page request limit.",
  "content.retry": "Retry",
  "content.retryAccessible": "Retry translation for this readable block",
  "content.retryPending": "Retrying…",
  "content.shown": "Translations shown.",
  "content.hidden": "Translations hidden.",
  "content.toggleEmpty": "There are no translations to toggle.",
  "content.translationSummary":
    "Translated {succeeded} readable blocks; {failed} unavailable.",
  "content.translationSummaryOmitted":
    "Translated {succeeded} readable blocks; {failed} unavailable; {omitted} additional blocks were skipped.",
  "content.translationUnavailable": "Translation unavailable. {error}",
  "options.apiKeyConfigured": "API key configured; leave blank to keep it",
  "options.apiKeyEmpty": "Enter API key",
  "options.apiKey": "API key",
  "options.appearance": "Appearance",
  "options.appearanceNotice":
    "These settings affect only Paralume translation, failure, and retry UI.",
  "options.backgroundColor": "Background color",
  "options.baseUrl": "HTTPS Base URL",
  "options.clearMicrosoftKey": "Clear Microsoft key",
  "options.clearOpenAiKey": "Clear OpenAI-compatible key",
  "options.endpoint": "HTTPS Endpoint",
  "options.fontFamily": "Font family",
  "options.fontFamilyMonospace": "Monospace",
  "options.fontFamilySansSerif": "Sans serif",
  "options.fontFamilySerif": "Serif",
  "options.fontFamilySystem": "System default",
  "options.fontSize": "Font size",
  "options.language": "Interface language",
  "options.languageEnglish": "English",
  "options.languageSimplifiedChinese": "Simplified Chinese",
  "options.languageSystem": "System default",
  "options.lineHeight": "Line height",
  "options.loading": "Loading settings…",
  "options.microsoftApiKey": "API key",
  "options.mockNotice":
    "Mock is deterministic development output and is never selected as an automatic fallback.",
  "options.model": "Model",
  "options.opacity": "Opacity",
  "options.openAiApiKey": "API key",
  "options.openAiCompatibilityNotice":
    "The endpoint must support strict JSON Schema output and the selected protocol.",
  "options.options": "Options",
  "options.protocol": "Protocol",
  "options.provider": "Provider",
  "options.providerMicrosoft": "Microsoft Translator",
  "options.providerMock": "Mock (development only)",
  "options.providerOpenAi": "OpenAI-compatible",
  "options.reasoningEffort": "Reasoning effort",
  "options.reasoningHigh": "High",
  "options.reasoningLow": "Low",
  "options.reasoningMedium": "Medium",
  "options.reasoningMinimal": "Minimal",
  "options.reasoningNone": "None",
  "options.region": "Region",
  "options.resetAppearance": "Reset appearance",
  "options.retry": "Automatic retry",
  "options.retryCostNotice":
    "Automatic retries repeat the whole failed batch and may increase provider usage or cost.",
  "options.retryEnabled": "Retry recoverable provider failures",
  "options.retryMax": "Additional attempts",
  "options.save": "Save settings",
  "options.storageWarning":
    "API keys are stored in chrome.storage.local on this browser profile. This local storage is not an encrypted vault.",
  "options.testConnection": "Test saved provider",
  "options.textColor": "Text color",
  "options.translationProvider": "Translation provider",
  "options.verticalSpacing": "Vertical spacing",
  "popup.clear": "Clear",
  "popup.clearing": "Clearing…",
  "popup.description":
    "Translate readable page text while preserving the original webpage.",
  "popup.failures": "Unavailable: {count}",
  "popup.hidden": "Translations are hidden.",
  "popup.ready": "Ready. Translation runs only when you request it.",
  "popup.title": "Bilingual reading",
  "popup.toggle": "Show / hide",
  "popup.toggling": "Updating…",
  "popup.translate": "Translate page",
  "popup.translated": "Translations: {count}",
  "popup.translating": "Translating…",
  "popup.visible": "Translations are visible.",
  "settings.loaded": "Settings loaded.",
  "settings.microsoftKeyCleared": "Microsoft Translator API key cleared.",
  "settings.openAiKeyCleared": "OpenAI-compatible API key cleared.",
  "settings.permissionRemovalFailed":
    "Settings were saved, but the previous provider permission could not be removed. Remove it from the browser extension settings.",
  "settings.saved": "Settings saved.",
  "settings.testSucceeded": "Provider connection test succeeded.",
} as const;

export type MessageId = keyof typeof EN_MESSAGES;
export type MessageValue = string | number;
export type MessageValues = Readonly<Record<string, MessageValue>>;

export interface MessageDescriptor {
  readonly id: MessageId;
  readonly values?: MessageValues;
}

const ZH_CN_MESSAGES: Record<MessageId, string> = {
  "content.alreadyUpToDate": "译文已是最新状态。",
  "content.cancelled": "因译文已被清除，本次翻译已取消。",
  "content.clearEmpty": "没有可清除的译文。",
  "content.clearEmptyCancelled":
    "没有已渲染的译文可清除；已请求取消等待中的翻译任务。",
  "content.cleared": "已清除 {count} 条译文。",
  "content.clearedAndCancelled":
    "已清除 {count} 条译文，并请求取消等待中的翻译任务。",
  "content.noEligible": "此页面未找到符合条件的可读文本块。",
  "content.noFit": "没有可读文本块能放入单页请求限制。",
  "content.noFitOmitted":
    "没有可读文本块能放入单页请求限制；已跳过 {omitted} 个。",
  "content.omitted": "另有 {count} 个可读文本块因单页请求限制而跳过。",
  "content.retry": "重试",
  "content.retryAccessible": "重试此可读文本块的翻译",
  "content.retryPending": "正在重试…",
  "content.shown": "已显示译文。",
  "content.hidden": "已隐藏译文。",
  "content.toggleEmpty": "没有可切换显示状态的译文。",
  "content.translationSummary":
    "已翻译 {succeeded} 个可读文本块；{failed} 个不可用。",
  "content.translationSummaryOmitted":
    "已翻译 {succeeded} 个可读文本块；{failed} 个不可用；另有 {omitted} 个已跳过。",
  "content.translationUnavailable": "译文不可用。{error}",
  "options.apiKeyConfigured": "已配置 API 密钥；留空可保留现有密钥",
  "options.apiKeyEmpty": "输入 API 密钥",
  "options.apiKey": "API 密钥",
  "options.appearance": "外观",
  "options.appearanceNotice":
    "这些设置仅影响 Paralume 的译文、失败提示和重试界面。",
  "options.backgroundColor": "背景颜色",
  "options.baseUrl": "HTTPS 基础 URL",
  "options.clearMicrosoftKey": "清除 Microsoft 密钥",
  "options.clearOpenAiKey": "清除 OpenAI 兼容密钥",
  "options.endpoint": "HTTPS 端点",
  "options.fontFamily": "字体",
  "options.fontFamilyMonospace": "等宽字体",
  "options.fontFamilySansSerif": "无衬线字体",
  "options.fontFamilySerif": "衬线字体",
  "options.fontFamilySystem": "系统默认",
  "options.fontSize": "字号",
  "options.language": "界面语言",
  "options.languageEnglish": "英语",
  "options.languageSimplifiedChinese": "简体中文",
  "options.languageSystem": "跟随系统",
  "options.lineHeight": "行高",
  "options.loading": "正在加载设置…",
  "options.microsoftApiKey": "API 密钥",
  "options.mockNotice": "Mock 提供确定性的开发输出，且绝不会被自动用作回退。",
  "options.model": "模型",
  "options.opacity": "不透明度",
  "options.openAiApiKey": "API 密钥",
  "options.openAiCompatibilityNotice":
    "端点必须支持严格 JSON Schema 输出及所选协议。",
  "options.options": "选项",
  "options.protocol": "协议",
  "options.provider": "服务提供方",
  "options.providerMicrosoft": "Microsoft Translator",
  "options.providerMock": "Mock（仅开发）",
  "options.providerOpenAi": "OpenAI 兼容",
  "options.reasoningEffort": "推理强度",
  "options.reasoningHigh": "高",
  "options.reasoningLow": "低",
  "options.reasoningMedium": "中",
  "options.reasoningMinimal": "最小",
  "options.reasoningNone": "无",
  "options.region": "区域",
  "options.resetAppearance": "重置外观",
  "options.retry": "自动重试",
  "options.retryCostNotice":
    "自动重试会重新提交整个失败批次，可能增加服务用量或费用。",
  "options.retryEnabled": "重试可恢复的服务错误",
  "options.retryMax": "额外尝试次数",
  "options.save": "保存设置",
  "options.storageWarning":
    "API 密钥存储在此浏览器配置文件的 chrome.storage.local 中；本地存储不是加密保险库。",
  "options.testConnection": "测试已保存的服务",
  "options.textColor": "文字颜色",
  "options.translationProvider": "翻译服务",
  "options.verticalSpacing": "垂直间距",
  "popup.clear": "清除",
  "popup.clearing": "正在清除…",
  "popup.description": "翻译页面中的可读文本，同时保留原网页内容。",
  "popup.failures": "不可用：{count}",
  "popup.hidden": "译文已隐藏。",
  "popup.ready": "已就绪。仅在你主动请求时翻译。",
  "popup.title": "双语阅读",
  "popup.toggle": "显示 / 隐藏",
  "popup.toggling": "正在更新…",
  "popup.translate": "翻译页面",
  "popup.translated": "译文：{count}",
  "popup.translating": "正在翻译…",
  "popup.visible": "译文已显示。",
  "settings.loaded": "设置已加载。",
  "settings.microsoftKeyCleared": "已清除 Microsoft Translator API 密钥。",
  "settings.openAiKeyCleared": "已清除 OpenAI 兼容 API 密钥。",
  "settings.permissionRemovalFailed":
    "设置已保存，但无法移除之前的服务权限。请在浏览器扩展程序设置中将其移除。",
  "settings.saved": "设置已保存。",
  "settings.testSucceeded": "翻译服务连接测试成功。",
};

const ZH_CN_ERRORS: Record<ErrorCode, string> = {
  INVALID_MESSAGE: "请求或响应格式不正确。",
  NO_ACTIVE_TAB: "Paralume 无法访问当前活动标签页。",
  RESTRICTED_PAGE:
    "Paralume 无法在浏览器内部页面、扩展程序页面或其他受限页面运行。请打开普通网页后重试。",
  INJECTION_FAILED: "Paralume 无法访问此页面。请重新加载页面后重试。",
  TRANSLATION_FAILED: "翻译请求失败。请检查服务设置后重试。",
  TRANSLATION_CANCELLED: "翻译任务已取消。",
  REQUEST_LIMIT_EXCEEDED: "此页面文本过多，无法在一次翻译请求中处理。",
  SEGMENT_TOO_LARGE: "某个可读文本块超过了翻译批次字符限制。",
  MISSING_RESULT: "翻译服务未返回所请求文本块的结果。",
  DUPLICATE_RESULT: "翻译服务为同一文本块返回了重复结果。",
  INTERNAL_ERROR: "Paralume 无法完成该请求。",
  AUTHENTICATION_FAILED: "翻译服务拒绝了已配置的凭据。",
  RATE_LIMITED: "已达到翻译服务速率限制，请稍后重试。",
  REQUEST_TIMEOUT: "翻译服务请求超时，请重试。",
  NETWORK_ERROR: "无法连接翻译服务。请检查网络和端点设置。",
  SERVER_UNAVAILABLE: "翻译服务暂时不可用，请稍后重试。",
  MALFORMED_JSON: "翻译服务返回了格式错误的 JSON。",
  MALFORMED_PROVIDER_OUTPUT: "翻译服务返回的内容不符合所需格式。",
  API_KEY_UNCONFIGURED: "尚未配置所选翻译服务的 API 密钥。",
  PERMISSION_MISSING:
    "尚未授予已配置翻译服务来源的访问权限，请重新保存服务设置。",
  VALIDATION_ERROR: "翻译服务设置无效，请检查各字段后重试。",
};

const CATALOGS: Record<UiLocale, Record<MessageId, string>> = {
  en: EN_MESSAGES,
  "zh-CN": ZH_CN_MESSAGES,
};

function isSimplifiedChinese(language: string): boolean {
  const normalized = language.trim().toLowerCase();
  return (
    normalized === "zh" ||
    normalized.startsWith("zh-cn") ||
    normalized.startsWith("zh-hans") ||
    normalized.startsWith("zh-sg")
  );
}

export function resolveUiLocale(
  setting: UiLanguageSetting,
  browserLanguage?: string,
): UiLocale {
  if (setting !== "system") {
    return setting;
  }
  return browserLanguage !== undefined && isSimplifiedChinese(browserLanguage)
    ? "zh-CN"
    : "en";
}

export function createMessage(
  id: MessageId,
  values?: MessageValues,
): MessageDescriptor {
  return values === undefined ? { id } : { id, values };
}

export function isMessageId(value: unknown): value is MessageId {
  return typeof value === "string" && Object.hasOwn(EN_MESSAGES, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseMessageDescriptor(
  value: unknown,
): MessageDescriptor | undefined {
  if (!isRecord(value) || !isMessageId(value["id"])) {
    return undefined;
  }
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "id") {
    return { id: value["id"] };
  }
  if (
    keys.length !== 2 ||
    !keys.includes("id") ||
    !keys.includes("values") ||
    !isRecord(value["values"]) ||
    Object.keys(value["values"]).length > 20
  ) {
    return undefined;
  }
  for (const candidate of Object.values(value["values"])) {
    if (
      (typeof candidate !== "string" && typeof candidate !== "number") ||
      (typeof candidate === "string" && candidate.length > 2_000) ||
      (typeof candidate === "number" && !Number.isFinite(candidate))
    ) {
      return undefined;
    }
  }
  return {
    id: value["id"],
    values: value["values"] as Readonly<Record<string, MessageValue>>,
  };
}

export function formatMessage(
  locale: UiLocale,
  id: MessageId,
  values: MessageValues = {},
): string {
  const catalog: Readonly<Record<string, string>> = CATALOGS[locale];
  const template = catalog[id];
  if (template === undefined) {
    throw new Error(`Unknown localization message identifier: ${id}`);
  }

  return template.replace(
    /\{([a-zA-Z][a-zA-Z0-9]*)\}/gu,
    (_match: string, key: string) => {
      const value = values[key];
      return value === undefined ? `{${key}}` : String(value);
    },
  );
}

export function formatDescriptor(
  locale: UiLocale,
  descriptor: MessageDescriptor,
): string {
  return formatMessage(locale, descriptor.id, descriptor.values);
}

export function translateError(locale: UiLocale, code: ErrorCode): string {
  return locale === "zh-CN" ? ZH_CN_ERRORS[code] : SAFE_ERROR_MESSAGES[code];
}

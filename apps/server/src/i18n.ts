import type { Locale } from './types';

export const en = {
  appName: 'OpenFitness',
  signIn: 'Sign in with a passkey',
  setup: 'Set up OpenFitness',
  setupHelp: 'Enter the deployment setup token to register your first passkey.',
  setupToken: 'Setup token',
  passkeyName: 'Passkey name',
  registerPasskey: 'Register a passkey',
  addPasskey: 'Add a backup passkey',
  signOut: 'Sign out',
  language: 'Language',
  englishName: 'English',
  simplifiedChineseName: '简体中文',
  defaultPasskeyName: 'Passkey',
  defaultBackupPasskeyName: 'Backup passkey',
  authorize: 'Authorize connection',
  consentTitle: 'Connect a fitness assistant',
  consentHelp:
    'This connection can read, create, change, and delete your training, recipes, meals, and media.',
  clientLabel: 'Client',
  clientDomainLabel: 'Verified client domain',
  selfRegisteredClient: 'This client registered its own name; the name is not verified.',
  scopesLabel: 'Permissions',
  fullAccess: 'Full access to fitness records (fitness:full)',
  offlineAccess: 'Stay connected using refresh tokens (offline_access)',
  healthAccess: 'Enroll this iPhone and deliver Apple Health exports (health:sync)',
  healthPermissionRequired:
    'Authorize the separate Apple Health sync permission to enroll this iPhone.',
  healthDeviceRevoked: 'This health device is no longer authorized. Connect it again.',
  healthWriterConflict:
    'Another iPhone is the selected nutrition writer or has an active synchronization lease.',
  healthLeaseExpired:
    'This export lease expired or the meal changed. Fetch the latest export before syncing.',
  loopbackWarning:
    'This returns access to an application on your computer. Continue only if you just started connecting it.',
  clientUnverified: 'The client metadata could not be verified. Start the connection again later.',
  redirectLabel: 'Return address',
  allow: 'Allow connection',
  deny: 'Deny connection',
  connections: 'Connected assistants',
  revoke: 'Revoke',
  noConnections: 'No active connections.',
  success: 'Completed successfully.',
  failure: 'The operation could not be completed. Please try again.',
  invalidInput: 'Some input is missing or invalid.',
  unauthorized: 'Authentication is required.',
  forbidden: 'This operation is not allowed.',
  notFound: 'The requested record was not found.',
  conflict: 'This record changed. Read the latest version and try again.',
  idempotencyConflict: 'This operation ID was already used with different input.',
  missingData: 'More information is required to calculate nutrition.',
  upstreamUnavailable:
    'The food data provider is unavailable. Retry later or provide a labeled estimate.',
  rateLimited: 'Too many requests. Please try again later.',
  invalidImage: 'Upload a valid JPEG, PNG, or WebP image.',
  imageTooLarge: 'The image exceeds the upload size limit.',
  uploadExpired: 'This upload link expired or has already been used.',
  invalidSource: 'The image source must be a public HTTPS address.',
  awaitingDevice: 'Waiting for a device to sync with Apple Health.',
  internalError: 'An unexpected error occurred.',
  botInstructions:
    'You are the personal fitness coach connected to OpenFitness. Read the owner identity and capabilities before acting. Use tools to inspect existing exercises, plans, recipes, and history. Plan training, explain exercises, and log actual performance separately from planned targets. Reuse saved recipes and ask for missing portion information. Label nutrition estimates and preserve their basis. Use one stable operationId for retries and read current versions before editing. Change a meal for one-off adjustments; change a recipe only for future standard servings. Process images with your own tools before saving them. Never claim Apple Health synchronization while its status is awaiting_device. You have full business permissions for this owner; platform administration and passkey management belong to the owner.',
} as const;

type Messages = { [K in keyof typeof en]: string };
export const zhCN: Messages = {
  appName: 'OpenFitness',
  signIn: '使用通行密钥登录',
  setup: '设置 OpenFitness',
  setupHelp: '输入部署时配置的引导口令，注册第一枚通行密钥。',
  setupToken: '引导口令',
  passkeyName: '通行密钥名称',
  registerPasskey: '注册通行密钥',
  addPasskey: '添加备用通行密钥',
  signOut: '退出登录',
  language: '语言',
  englishName: 'English',
  simplifiedChineseName: '简体中文',
  defaultPasskeyName: '通行密钥',
  defaultBackupPasskeyName: '备用通行密钥',
  authorize: '授权连接',
  consentTitle: '连接健身助手',
  consentHelp: '此连接可以读取、创建、修改和删除你的训练、食谱、饮食与媒体记录。',
  clientLabel: '客户端',
  clientDomainLabel: '已验证的客户端域名',
  selfRegisteredClient: '此客户端自行注册了名称，该名称未经验证。',
  scopesLabel: '权限',
  fullAccess: '全部健身业务权限（fitness:full）',
  offlineAccess: '使用刷新令牌保持连接（offline_access）',
  healthAccess: '注册此 iPhone 并提交 Apple 健康同步回执（health:sync）',
  healthPermissionRequired: '请单独授权 Apple 健康同步权限，以注册此 iPhone。',
  healthDeviceRevoked: '此健康设备已被撤销授权，请重新连接。',
  healthWriterConflict: '另一部 iPhone 是当前饮食写入设备，或仍在同步中。',
  healthLeaseExpired: '同步租约已过期或饮食已更新，请重新获取最新事件。',
  loopbackWarning: '授权将返回你电脑上的应用。仅在你刚刚主动发起连接时继续。',
  clientUnverified: '无法验证客户端元数据，请稍后重新发起连接。',
  redirectLabel: '返回地址',
  allow: '允许连接',
  deny: '拒绝连接',
  connections: '已连接的助手',
  revoke: '撤销',
  noConnections: '暂无有效连接。',
  success: '操作成功。',
  failure: '无法完成操作，请重试。',
  invalidInput: '输入信息缺失或格式不正确。',
  unauthorized: '请先完成身份验证。',
  forbidden: '不允许执行此操作。',
  notFound: '找不到所请求的记录。',
  conflict: '记录已被修改，请读取最新版本后重试。',
  idempotencyConflict: '此操作标识已用于不同的输入。',
  missingData: '需要补充信息才能计算营养。',
  upstreamUnavailable: '食物数据服务暂不可用，请稍后重试或提供明确标注的估算。',
  rateLimited: '请求过于频繁，请稍后重试。',
  invalidImage: '请上传有效的 JPEG、PNG 或 WebP 图片。',
  imageTooLarge: '图片超过上传大小限制。',
  uploadExpired: '上传链接已过期或已被使用。',
  invalidSource: '图片来源必须是公开的 HTTPS 地址。',
  awaitingDevice: '等待设备同步至 Apple 健康。',
  internalError: '发生未知错误。',
  botInstructions:
    '你是连接 OpenFitness 的个人健身教练。操作前先读取用户身份和当前能力。通过工具查询现有动作、计划、食谱和历史。制订训练计划、解释动作，并将实际表现与计划目标分别记录。优先复用食谱，份量不明确时追问。明确标注营养估算并保留依据。重试使用相同的 operationId，修改前读取最新版本。单次调整只修改该餐；标准份量变化才更新食谱，供未来使用。先用你自己的工具处理图片，再保存。状态为 awaiting_device 时，不得声称已同步至 Apple 健康。你拥有此用户全部业务操作权限；平台管理和通行密钥管理由用户执行。',
};
export type MessageKey = keyof typeof en;
export const messages: Record<Locale, Messages> = { en, 'zh-CN': zhCN };
export function t(locale: Locale, key: MessageKey): string {
  return messages[locale]?.[key] || en[key];
}
export function resolveLocale(preference?: string | null, acceptLanguage = ''): Locale {
  if (preference === 'en' || preference === 'zh-CN') return preference;
  const ranges = acceptLanguage
    .split(',')
    .map((part, index) => {
      const [name = '', ...params] = part.trim().split(';');
      const quality = params.find((p) => p.trim().startsWith('q='));
      return {
        name: name.toLowerCase(),
        quality: quality ? Number(quality.trim().slice(2)) : 1,
        index,
      };
    })
    .filter((r) => r.quality > 0 && r.quality <= 1)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  for (const { name } of ranges) {
    if (name === 'zh' || name === 'zh-cn' || name === 'zh-hans' || name.startsWith('zh-hans-'))
      return 'zh-CN';
    if (name === 'en' || name.startsWith('en-')) return 'en';
  }
  return 'en';
}

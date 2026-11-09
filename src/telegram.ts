import type { Chat, ChatMember, ChatPermissions, User } from 'grammy/types';

/** Everything off: the member can read but not post. */
export const MUTED: ChatPermissions = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
  can_change_info: false,
  can_invite_users: false,
  can_pin_messages: false,
  can_manage_topics: false,
};

/** Everything on. Telegram treats "all true" as lifting the restriction; the group's own defaults still apply. */
export const UNRESTRICTED: ChatPermissions = Object.fromEntries(
  Object.keys(MUTED).map((key) => [key, true]),
) as ChatPermissions;

export function isMember(m: ChatMember): boolean {
  switch (m.status) {
    case 'member':
    case 'administrator':
    case 'creator':
      return true;
    case 'restricted':
      return m.is_member;
    default:
      return false;
  }
}

export function isPrivileged(m: ChatMember): boolean {
  return m.status === 'administrator' || m.status === 'creator';
}

export function isGroupChat(chat: Chat): chat is Chat.GroupChat | Chat.SupergroupChat {
  return chat.type === 'group' || chat.type === 'supergroup';
}

export function chatTitle(chat: Chat): string {
  return 'title' in chat && chat.title ? chat.title : 'this group';
}

export function displayName(user: User): string {
  const full = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return full || (user.username ? `@${user.username}` : `user ${user.id}`);
}

export function mention(userId: number, name: string): string {
  return `<a href="tg://user?id=${userId}">${escapeHtml(name)}</a>`;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function formatSats(sats: number | bigint): string {
  return Number(sats).toLocaleString('en-US');
}

/** Deep-link payload for `t.me/<bot>?start=<payload>`; only [A-Za-z0-9_-] is allowed there. */
export function deepLinkPayload(chatId: number): string {
  return `c${chatId}`;
}

export function parseDeepLinkPayload(payload: string): number | undefined {
  const match = /^c(-?\d{1,20})$/.exec(payload.trim());
  if (!match) return undefined;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : undefined;
}

export function deepLink(botUsername: string, chatId: number): string {
  return `https://t.me/${botUsername}?start=${deepLinkPayload(chatId)}`;
}

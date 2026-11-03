/** The subset of the Telegram Bot API types this bot reads. */

export interface TgUser { id: number; is_bot: boolean; first_name: string; last_name?: string; username?: string }
export interface TgChat { id: number; type: "private" | "group" | "supergroup" | "channel" }
export interface TgEntity { type: string; offset: number; length: number }
export interface TgPhotoSize { file_id: string; width: number; height: number; file_size?: number }
export interface TgVoice { file_id: string; duration: number; mime_type?: string; file_size?: number }
export interface TgDocument { file_id: string; file_name?: string; mime_type?: string; file_size?: number }

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  message_thread_id?: number;
  is_topic_message?: boolean;
  text?: string;
  caption?: string;
  entities?: TgEntity[];
  caption_entities?: TgEntity[];
  photo?: TgPhotoSize[];
  voice?: TgVoice;
  audio?: TgVoice;
  document?: TgDocument;
  reply_to_message?: TgMessage;
}

export interface TgCallbackQuery { id: string; from: TgUser; data?: string; message?: TgMessage }
export type TgReaction = { type: "emoji"; emoji: string } | { type: "custom_emoji" | "paid"; custom_emoji_id?: string };
export interface TgMessageReaction { chat: TgChat; message_id: number; user?: TgUser; new_reaction: TgReaction[] }

export type TgMemberStatus = "creator" | "administrator" | "member" | "restricted" | "left" | "kicked";
export interface TgChatMember { status: TgMemberStatus; user: TgUser; is_member?: boolean }
/** A member's status changed (requires the bot to be admin and "chat_member" in allowed_updates). */
export interface TgChatMemberUpdated { chat: TgChat; from: TgUser; date: number; old_chat_member: TgChatMember; new_chat_member: TgChatMember }

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
  message_reaction?: TgMessageReaction;
  chat_member?: TgChatMemberUpdated;
}

export interface InlineKeyboard { inline_keyboard: { text: string; callback_data: string }[][] }

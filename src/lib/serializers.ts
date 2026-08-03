import type { Attachment, Prisma, Reaction, User } from "@prisma/client";

export function toPublicUser(user: User) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    bio: user.bio,
    isVerified: user.isVerified,
    isOnline: user.isOnline,
    lastSeenAt: user.lastSeenAt,
    createdAt: user.createdAt
  };
}

export type PublicUser = ReturnType<typeof toPublicUser>;

type ChatParticipantWithChat = Prisma.ChatParticipantGetPayload<{
  include: {
    chat: {
      include: {
        participants: { include: { user: true } };
        group: true;
        messages: {
          include: { attachments: true; sender: true; reactions: true };
        };
      };
    };
  };
}>;

/** Maps a ChatParticipant row (the current user's view of a chat) onto the
 * client's ChatListItem shape — pin/mute/archive/unread come straight off
 * the participant row; name/avatar resolve from the other user (DIRECT) or
 * the Group (GROUP). */
export function toChatListItem(row: ChatParticipantWithChat, currentUserId: string) {
  const { chat } = row;
  const otherParticipant =
    chat.type === "DIRECT" ? chat.participants.find((p) => p.userId !== currentUserId) : undefined;

  const lastMessage = chat.messages[0] ? toMessageSummary(chat.messages[0]) : null;

  return {
    id: chat.id,
    type: chat.type,
    name: chat.type === "GROUP" ? chat.group?.name ?? "Group" : otherParticipant?.user.name ?? "Unknown",
    avatarUrl: chat.type === "GROUP" ? chat.group?.avatarUrl ?? null : otherParticipant?.user.avatarUrl ?? null,
    otherUser: otherParticipant ? toPublicUser(otherParticipant.user) : null,
    groupId: chat.group?.id ?? null,
    isPinned: row.isPinned,
    isMuted: row.isMuted,
    isArchived: row.isArchived,
    unreadCount: row.unreadCount,
    lastMessage,
    participantCount: chat.participants.length,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt
  };
}

type ChatWithParticipants = Prisma.ChatGetPayload<{
  include: { participants: { include: { user: true } }; group: true };
}>;

/** Chat header for GET /api/chats/[id] — same identity fields as
 * ChatListItem, without the embedded last message (returned separately,
 * paginated, alongside this). */
export function toChatHeader(
  chat: ChatWithParticipants,
  participant: { isPinned: boolean; isMuted: boolean; isArchived: boolean },
  currentUserId: string
) {
  const otherParticipant =
    chat.type === "DIRECT" ? chat.participants.find((p) => p.userId !== currentUserId) : undefined;

  return {
    id: chat.id,
    type: chat.type,
    name: chat.type === "GROUP" ? chat.group?.name ?? "Group" : otherParticipant?.user.name ?? "Unknown",
    avatarUrl: chat.type === "GROUP" ? chat.group?.avatarUrl ?? null : otherParticipant?.user.avatarUrl ?? null,
    otherUser: otherParticipant ? toPublicUser(otherParticipant.user) : null,
    groupId: chat.group?.id ?? null,
    isPinned: participant.isPinned,
    isMuted: participant.isMuted,
    isArchived: participant.isArchived,
    participants: chat.participants.map((p) => toPublicUser(p.user)),
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt
  };
}

export const MESSAGE_INCLUDE = { attachments: true, sender: true, reactions: true } as const;

type MessageWithRelations = Prisma.MessageGetPayload<{
  include: typeof MESSAGE_INCLUDE;
}>;

export function toMessageSummary(message: MessageWithRelations) {
  return {
    id: message.id,
    chatId: message.chatId,
    senderId: message.senderId,
    type: message.type,
    text: message.isDeleted ? null : message.text,
    isDeleted: message.isDeleted,
    createdAt: message.createdAt
  };
}

export function toMessageDTO(message: MessageWithRelations) {
  return {
    id: message.id,
    chatId: message.chatId,
    senderId: message.senderId,
    sender: toPublicUser(message.sender),
    type: message.type,
    text: message.isDeleted ? null : message.text,
    replyToId: message.replyToId,
    isEdited: message.isEdited,
    editedAt: message.editedAt,
    isDeleted: message.isDeleted,
    deletedAt: message.deletedAt,
    createdAt: message.createdAt,
    attachments: message.attachments.map(toAttachmentDTO),
    reactions: message.reactions.map(toReactionDTO)
  };
}

export function toAttachmentDTO(attachment: Attachment) {
  return {
    id: attachment.id,
    messageId: attachment.messageId,
    type: attachment.type,
    url: attachment.url,
    fileName: attachment.fileName,
    fileSize: attachment.fileSize,
    width: attachment.width,
    height: attachment.height,
    duration: attachment.duration,
    waveform: attachment.waveform,
    thumbnail: attachment.thumbnail
  };
}

export function toReactionDTO(reaction: Reaction) {
  return {
    id: reaction.id,
    messageId: reaction.messageId,
    userId: reaction.userId,
    emoji: reaction.emoji,
    createdAt: reaction.createdAt
  };
}

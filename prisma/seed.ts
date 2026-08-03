import { PrismaClient, MessageStatus } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function upsertUser(input: {
  username: string;
  email: string;
  name: string;
  avatarUrl?: string;
  bio?: string;
}) {
  const passwordHash = await bcrypt.hash("Password123!", 10);
  return prisma.user.upsert({
    where: { email: input.email },
    update: {},
    create: {
      username: input.username,
      email: input.email,
      passwordHash,
      name: input.name,
      avatarUrl: input.avatarUrl,
      bio: input.bio,
      isVerified: true
    }
  });
}

async function main() {
  const alice = await upsertUser({
    username: "alice",
    email: "alice@nivichat.dev",
    name: "Alice Johnson",
    bio: "Product designer"
  });
  const bob = await upsertUser({
    username: "bob",
    email: "bob@nivichat.dev",
    name: "Bob Martinez",
    bio: "Backend engineer"
  });
  const carol = await upsertUser({
    username: "carol",
    email: "carol@nivichat.dev",
    name: "Carol Lee",
    bio: "Mobile engineer"
  });

  // --- Direct chat: Alice <-> Bob ---
  const existingDirect = await prisma.chat.findFirst({
    where: {
      type: "DIRECT",
      participants: { every: { userId: { in: [alice.id, bob.id] } } },
      AND: [
        { participants: { some: { userId: alice.id } } },
        { participants: { some: { userId: bob.id } } }
      ]
    }
  });

  const directChat =
    existingDirect ??
    (await prisma.chat.create({
      data: {
        type: "DIRECT",
        participants: {
          create: [{ userId: alice.id }, { userId: bob.id }]
        }
      }
    }));

  const directMessage1 = await prisma.message.create({
    data: {
      chatId: directChat.id,
      senderId: alice.id,
      type: "TEXT",
      text: "Hey Bob! Backend repo is finally live.",
      receipts: {
        create: [{ userId: bob.id, status: MessageStatus.DELIVERED }]
      }
    }
  });

  await prisma.message.create({
    data: {
      chatId: directChat.id,
      senderId: bob.id,
      type: "TEXT",
      text: "Nice, pulling it down now.",
      replyToId: directMessage1.id,
      receipts: {
        create: [{ userId: alice.id, status: MessageStatus.SEEN }]
      }
    }
  });

  // --- Group chat: Alice, Bob, Carol ---
  const existingGroupChat = await prisma.group.findFirst({
    where: { name: "NiviChat Core Team" }
  });

  let groupChatId: string;
  if (existingGroupChat) {
    groupChatId = existingGroupChat.chatId;
  } else {
    const groupChat = await prisma.chat.create({
      data: {
        type: "GROUP",
        participants: {
          create: [
            { userId: alice.id, isPinned: true },
            { userId: bob.id },
            { userId: carol.id }
          ]
        }
      }
    });
    groupChatId = groupChat.id;

    await prisma.group.create({
      data: {
        chatId: groupChat.id,
        name: "NiviChat Core Team",
        description: "Build squad for the NiviChat MVP",
        createdBy: alice.id,
        members: {
          create: [
            { userId: alice.id, role: "ADMIN" },
            { userId: bob.id, role: "MEMBER" },
            { userId: carol.id, role: "MEMBER" }
          ]
        }
      }
    });
  }

  await prisma.message.create({
    data: {
      chatId: groupChatId,
      senderId: carol.id,
      type: "TEXT",
      text: "Mobile client is ready for the real /api/chats data whenever you are.",
      receipts: {
        create: [
          { userId: alice.id, status: MessageStatus.SEEN },
          { userId: bob.id, status: MessageStatus.DELIVERED }
        ]
      }
    }
  });

  console.log("Seed complete:", {
    users: [alice.username, bob.username, carol.username],
    directChatId: directChat.id,
    groupChatId
  });
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

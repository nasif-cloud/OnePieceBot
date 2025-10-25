import Progress from "../models/Progress.js";
import { getCardById } from "../cards.js";
import { buildCardEmbed } from "../lib/cardEmbed.js";
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

export const name = "interactionCreate";
export const once = false;

// use shared embed builder to keep UI consistent across commands and interactions

function getEvolutionChain(rootCard) {
  const chain = [];
  const visited = new Set();
  function walk(card) {
    if (!card || visited.has(card.id)) return;
    visited.add(card.id);
    chain.push(card.id);
    const ev = card.evolutions || [];
    for (const nextId of ev) {
      const next = getCardById(nextId);
      if (next) walk(next);
    }
  }
  walk(rootCard);
  return chain;
}

export async function execute(interaction, client) {
  // handle component interactions (buttons) first
  try {
    if (interaction.isButton()) {
      const id = interaction.customId || "";
      // only handle known prefixes
      if (!id.startsWith("info_") && !id.startsWith("collection_") && !id.startsWith("quest_")) return;

      const parts = id.split(":");
      if (parts.length < 2) return;
      const action = parts[0];
      const ownerId = parts[1];

      // only allow the user who requested to use these buttons
      if (interaction.user.id !== ownerId) {
        await interaction.reply({ content: "Only the original requester can use these buttons.", ephemeral: true });
        return;
      }

      // INFO: support info_goto:<userId>:<rootCardId>:<index> and info_prev/info_next:<userId>:<cardId>
        // Handle quest view/claim buttons
      if (action === "quest_view") {
        const questType = parts[2]; // daily or weekly
        const userId = parts[3];

        if (interaction.user.id !== userId) {
          await interaction.reply({ content: "Only the original requester can use these buttons.", ephemeral: true });
          return;
        }

        const Quest = (await import("../models/Quest.js")).default;
        let questDoc = await Quest.getCurrentQuests(questType);
        
        if (!questDoc.quests.length) {
          const { generateQuests } = await import("../lib/quests.js");
          questDoc.quests = generateQuests(questType);
          await questDoc.save();
        }

        const questEmbed = await (await import("../commands/quests.js")).buildQuestEmbed(questDoc, interaction.user);

        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId(`quest_view:daily:${userId}`)
              .setLabel("Daily")
              .setStyle(questType === "daily" ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(`quest_view:weekly:${userId}`)
              .setLabel("Weekly")
              .setStyle(questType === "weekly" ? ButtonStyle.Primary : ButtonStyle.Secondary)
          );

        const claimRow = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId(`quest_claim:${userId}`)
              .setLabel("Claim Completed")
              .setStyle(ButtonStyle.Success)
          );

        await interaction.update({
          embeds: [questEmbed],
          components: [row, claimRow]
        });
        return;
      }

      if (action === "quest_claim") {
        const userId = parts[1];
        
        if (interaction.user.id !== userId) {
          await interaction.reply({ content: "Only the original requester can use these buttons.", ephemeral: true });
          return;
        }

        const Quest = (await import("../models/Quest.js")).default;
        const Balance = (await import("../models/Balance.js")).default;
        const { calculateQuestRewards } = await import("../lib/quests.js");

        // Get both daily and weekly quests
        const [dailyQuests, weeklyQuests] = await Promise.all([
          Quest.getCurrentQuests("daily"),
          Quest.getCurrentQuests("weekly")
        ]);

        let claimed = 0;
        let totalMoney = 0;
        let totalChests = [];
        let totalResetTokens = 0;

        // Process both quest sets
        for (const questDoc of [dailyQuests, weeklyQuests]) {
          const userProgress = questDoc.getUserProgress(userId);
          
          for (const quest of questDoc.quests) {
            const progress = userProgress.get(quest.id);
            if (!progress || progress.claimed || progress.current < quest.target) continue;

            // Calculate rewards
            const rewards = calculateQuestRewards(quest);
            totalMoney += rewards.money;
            totalChests.push(...rewards.chests);
            totalResetTokens += rewards.resetTokens;

            // Mark as claimed
            progress.claimed = true;
            userProgress.set(quest.id, progress);
            claimed++;
          }

          if (claimed > 0) {
            questDoc.progress.set(userId, userProgress);
            await questDoc.save();
          }
        }

        if (claimed === 0) {
          await interaction.reply({ 
            content: "You have no completed quests to claim.", 
            ephemeral: true 
          });
          return;
        }

        // Update user's balance and inventory
        let bal = await Balance.findOne({ userId });
        if (!bal) bal = new Balance({ userId, amount: 500 });
        
        bal.amount += totalMoney;
        bal.resetTokens = (bal.resetTokens || 0) + totalResetTokens;
        await bal.save();

        // TODO: Add chests to inventory when chest system is implemented

        const rewardEmbed = new EmbedBuilder()
          .setTitle("Quests Claimed!")
          .setColor(0xFFFFFF)
          .setDescription(
            `You claimed ${claimed} quest${claimed !== 1 ? 's' : ''}!\n\n` +
            `Rewards:\n` +
            `• ${totalMoney}¥\n` +
            (totalResetTokens > 0 ? `• ${totalResetTokens} Reset Token${totalResetTokens !== 1 ? 's' : ''}\n` : '') +
            (totalChests.length > 0 ? `• ${totalChests.map(c => `${c.count}× ${c.rank} Chest${c.count !== 1 ? 's' : ''}`).join(', ')}\n` : '')
          );

        await interaction.reply({ 
          embeds: [rewardEmbed], 
          ephemeral: true 
        });

        // Refresh the quest display
        const questDoc = interaction.message.embeds[0].title.toLowerCase().includes("daily") ? dailyQuests : weeklyQuests;
        const questEmbed = await (await import("../commands/quests.js")).buildQuestEmbed(questDoc, interaction.user);
        
        const components = interaction.message.components;
        await interaction.message.edit({
          embeds: [questEmbed],
          components
        });
        return;
      }

      // INFO paging: support info_prev/info_next customIds with index
      if (action === "info_prev" || action === "info_next") {
          const rootCardId = parts[2];
          const targetIndex = parseInt(parts[3] || "0", 10) || 0;
          const rootCard = getCardById(rootCardId);
          if (!rootCard) {
            await interaction.reply({ content: "Root card not found.", ephemeral: true });
            return;
          }

          const chain = getEvolutionChain(rootCard);
          const len = chain.length;
          if (len === 0) {
            await interaction.reply({ content: "No evolutions available for this card.", ephemeral: true });
            return;
          }

          const idx = ((targetIndex % len) + len) % len;
          const newCardId = chain[idx];
          const newCard = getCardById(newCardId);
          if (!newCard) {
            await interaction.reply({ content: "Evolution card not found.", ephemeral: true });
            return;
          }

          // fetch progress to check ownership
          const progDoc = await Progress.findOne({ userId: ownerId });
          const cardsMap = progDoc ? (progDoc.cards instanceof Map ? progDoc.cards : new Map(Object.entries(progDoc.cards || {}))) : new Map();
          const ownedEntry = cardsMap.get(newCard.id) || null;

          // build embed using shared builder so layout matches info command
          const newEmbed = buildCardEmbed(newCard, ownedEntry, interaction.user);
          if (!ownedEntry || (ownedEntry.count || 0) <= 0) {
            newEmbed.setColor(0x2f3136);
            newEmbed.setDescription("**NOT OWNED**");
          }

          // compute prev/next indices for this chain and attach buttons
          const prevIndex = (idx - 1 + len) % len;
          const nextIndex = (idx + 1) % len;
          const prevIdNew = `info_prev:${ownerId}:${rootCard.id}:${prevIndex}`;
          const nextIdNew = `info_next:${ownerId}:${rootCard.id}:${nextIndex}`;
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(prevIdNew).setLabel("Previous").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(nextIdNew).setLabel("Next").setStyle(ButtonStyle.Secondary)
          );

          await interaction.update({ embeds: [newEmbed], components: [row] });
          return;
        }



      // COLLECTION pagination: collection_prev/collection_next:<userId>:<sortKey>:<page>
      if (action.startsWith("collection_")) {
        const sortKey = parts[2];
        const pageNum = parseInt(parts[3] || "0", 10) || 0;

        const progDoc = await Progress.findOne({ userId: ownerId });
        if (!progDoc || !progDoc.cards) {
          await interaction.reply({ content: "You have no cards.", ephemeral: true });
          return;
        }

        const cardsMap = progDoc.cards instanceof Map ? progDoc.cards : new Map(Object.entries(progDoc.cards || {}));
        const items = [];
        for (const [cardId, entry] of cardsMap.entries()) {
          const card = getCardById(cardId);
          if (!card) continue;
          items.push({ card, entry });
        }

        function computeScoreLocal(card, entry) {
          const level = entry.level || 0;
          const multiplier = 1 + level * 0.01;
          const power = (card.power || 0) * multiplier;
          const health = (card.health || 0) * multiplier;
          return power + health * 0.2;
        }

        if (sortKey === "best") items.sort((a, b) => computeScoreLocal(b.card, b.entry) - computeScoreLocal(a.card, a.entry));
        else if (sortKey === "wtb") items.sort((a, b) => computeScoreLocal(a.card, a.entry) - computeScoreLocal(b.card, b.entry));
        else if (sortKey === "lbtw") items.sort((a, b) => (b.entry.level || 0) - (a.entry.level || 0));
        else if (sortKey === "lwtb") items.sort((a, b) => (a.entry.level || 0) - (b.entry.level || 0));
        else if (sortKey === "nto") items.sort((a, b) => (b.entry.acquiredAt || 0) - (a.entry.acquiredAt || 0));
        else if (sortKey === "otn") items.sort((a, b) => (a.entry.acquiredAt || 0) - (b.entry.acquiredAt || 0));

        const PAGE_SIZE = 5;
        const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
        let newPage = pageNum;
        if (action === "collection_prev") newPage = Math.max(0, pageNum - 1);
        if (action === "collection_next") newPage = Math.min(totalPages - 1, pageNum + 1);

        const pageItems = items.slice(newPage * PAGE_SIZE, (newPage + 1) * PAGE_SIZE);
        const lines = pageItems.map((it, idx) => {
          const card = it.card;
          const entry = it.entry;
          const level = entry.level || 0;
          const power = Math.round((card.power || 0) * (1 + level * 0.01));
          const attack = `${Math.round((card.attackRange?.[0] || 0) * (1 + level * 0.01))} - ${Math.round((card.attackRange?.[1] || 0) * (1 + level * 0.01))}`;
          const health = Math.round((card.health || 0) * (1 + level * 0.01));
          return `**${newPage * PAGE_SIZE + idx + 1}. ${card.name}** (Lv ${level}) — Power: ${power} | Attack: ${attack} | HP: ${health}`;
        });

        const embed = new EmbedBuilder().setTitle("Collection").setDescription(lines.join("\n")).setFooter({ text: `Page ${newPage + 1}/${totalPages}` });
        const prevIdNew = `collection_prev:${ownerId}:${sortKey}:${newPage}`;
        const nextIdNew = `collection_next:${ownerId}:${sortKey}:${newPage}`;
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(prevIdNew).setLabel("Previous").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(nextIdNew).setLabel("Next").setStyle(ButtonStyle.Secondary)
        );

        await interaction.update({ embeds: [embed], components: [row] });
        return;
      }
    }
  } catch (err) {
    console.error("Error handling button interaction:", err);
    try {
      if (!interaction.replied) await interaction.reply({ content: "Error handling interaction.", ephemeral: true });
    } catch (e) {}
    return;
  }

  // fallback to chat input commands (slash)
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName.toLowerCase());
  if (!command) return;

  try {
    await command.execute(interaction, client);
  } catch (error) {
    console.error(error);
    try {
      if (!interaction.replied) await interaction.reply({ content: "❌ There was an error executing this command.", ephemeral: true });
    } catch (e) {}
  }
}

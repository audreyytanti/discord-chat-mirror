/* eslint-disable no-await-in-loop */
/* eslint-disable id-length */
import process from "node:process";
import { setInterval } from "node:timers";

import type { APIAttachment, APIStickerItem, GatewayReceivePayload } from "discord.js";
import { WebhookClient, GatewayDispatchEvents, GatewayOpcodes } from "discord.js";

// FIX: Use the standard WebSocket type directly from the ws package.
import WebSocket from "ws";

// FIX: Removed 'WebsocketTypes' as it was causing compilation errors due to incomplete methods/properties.
import type { DiscordWebhook, Things } from "../typings/index.js";
// NOTE: We will import and use the new DISCORD_MIRROR_MAP environment variable.
import { discordToken, enableBotIndicator, headers, useWebhookProfile } from "../utils/env.js";

import logger from "../utils/logger.js";

// --- Configuration: List of user accounts whose non-webhook messages should be ignored. ---
const BLOCKED_USER_IDS = ["859535759501033534", "1422307880899444766", "681226848256000027"];
// -----------------------------------------------------------------------------------------


// =========================================================================
// === CONFIGURATION PARSING FOR MULTI-CHANNEL ROUTING ===
// =========================================================================
const RAW_MIRROR_MAP_JSON = process.env.DISCORD_MIRROR_MAP || "{}";
let MIRROR_MAP: Record<string, string[]> = {};
try {
    MIRROR_MAP = JSON.parse(RAW_MIRROR_MAP_JSON);
} catch (e) {
    logger.error("Failed to parse DISCORD_MIRROR_MAP. Ensure it is valid JSON.");
}

// 1. Derive the list of channel IDs the bot needs to listen to (keys of the map)
const CHANNELS_TO_LISTEN = Object.keys(MIRROR_MAP);

// 2. Derive the list of ALL destination webhook URLs (flattened values of the map)
const ALL_DESTINATION_WEBHOOKS = Object.values(MIRROR_MAP).flat();
// =========================================================================


export const executeWebhook = async (things: Things): Promise<void> => {
    const wsClient = new WebhookClient({ url: things.url });
    await wsClient.send(things);
};

let ws: WebSocket | undefined; // FIX: Use the correct WebSocket type from the 'ws' package
let resumeData = {
    sessionId: "",
    resumeGatewayUrl: "",
    seq: 0
};
let authenticated = false;
let botId: string | undefined;

// Store the IDs of our own destination webhooks to prevent self-looping.
let destinationWebhookIds: string[] = [];

// Helper function to get the current sequence number for heartbeats (0 or null initially)
const getCurrentSequence = (): number | null => resumeData.seq === 0 ? null : resumeData.seq;

/**
 * Extracts the Discord Webhook ID from a standard webhook URL.
 * Assumes the format: .../webhooks/{id}/{token}
 */
const getWebhookId = (url: string): string | undefined => {
    try {
        const match = url.match(/webhooks\/(\d+)\//);
        return match ? match[1] : undefined;
    } catch (e) {
        logger.error(`Error extracting webhook ID from URL: ${e}`);
        return undefined;
    }
};

/**
 * Ensures the existing WebSocket connection is cleaned up before starting a new one.
 * FIX for Issue 2: Prevents multiple listeners (double posting).
 */
const disconnectAndListen = (): void => {
    if (ws) {
        logger.info("Cleaning up old connection and listeners...");
        // These methods are now recognized by the compiler because `ws` is typed as `WebSocket`.
        ws.removeAllListeners(); 
        // Close the socket if it's open, although it might already be closing/closed
        ws.close(); 
    }
    // Start the new listening process
    listen(); 
};


export const listen = (): void => {
    if (resumeData.sessionId && resumeData.resumeGatewayUrl) {
        logger.info("Resuming session...");
        logger.debug(`Session ID: ${resumeData.sessionId}`);
        logger.debug(`Resume Gateway URL: ${resumeData.resumeGatewayUrl}`);
        logger.debug(`Sequence: ${resumeData.seq}`);

        // FIX: Use the imported WebSocket class name
        ws = new WebSocket(resumeData.resumeGatewayUrl);
        ws.send(
            JSON.stringify({
                op: 6,
                d: {
                    // CRITICAL: Prefix the token with "Bot " for Resume
                    token: `Bot ${discordToken}`,
                    // eslint-disable-next-line typescript/naming-convention
                    session_id: resumeData.sessionId,
                    seq: resumeData.seq
                }
            })
        );
    } else {
        logger.info("Starting new connection...");
        // FIX: Use the imported WebSocket class name
        ws = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
    }

    ws.on("open", () => {
        logger.info("Connected to the Discord WSS.");
    });
    
    // FIX for Issue 2: Reconnect on error
    // The `ws` typings expect `err` to be an Error object or similar, so we ensure reliable logging.
    ws.on('error', (err) => {
        logger.error(`WebSocket Error: ${err.toString()}. Reconnecting...`);
        disconnectAndListen();
    });
    
    // FIX for Issue 2: Reconnect on close
    // FIX for Error 3: Explicitly type the arguments to satisfy the TypeScript compiler.
    ws.on("close", (code: number, reason: Buffer) => {
        logger.warn(`Connection closed (Code: ${code}, Reason: ${reason.toString()}). Attempting to reconnect...`);
        disconnectAndListen();
    });

    ws.on("message", async (data: [any]) => {
        const payload: GatewayReceivePayload = JSON.parse(data.toString()) as GatewayReceivePayload;
        const { op, d, s, t } = payload;
        resumeData.seq = s ?? resumeData.seq;

        switch (op) {
            case GatewayOpcodes.Hello:
                logger.info("Hello event received. Starting heartbeat...");

                // Send the first Heartbeat immediately, using the tracked sequence number (0 or null)
                ws!.send( // Using non-null assertion as it must be defined here
                    JSON.stringify({
                        op: 1,
                        d: getCurrentSequence()
                    })
                );

                setInterval(() => {
                    // Check if ws is still defined and open before sending heartbeat
                    if (ws && ws.readyState === WebSocket.OPEN) { // FIX: Use WebSocket.OPEN (and now recognized)
                        ws.send(
                            JSON.stringify({
                                op: 1,
                                d: getCurrentSequence() // Use the tracked sequence number
                            })
                        );
                        logger.debug("Heartbeat sent.");
                    }
                }, d.heartbeat_interval);

                logger.info("Heartbeat started.");
                break;
            case GatewayOpcodes.Heartbeat:
                logger.debug("Discord requested an immediate heartbeat.");
                ws!.send(
                    JSON.stringify({
                        op: 1,
                        d: getCurrentSequence() // Use the tracked sequence number
                    })
                );
                logger.debug("Heartbeat sent.");
                break;
            case GatewayOpcodes.HeartbeatAck:
                if (!authenticated) {
                    authenticated = true;
                    ws!.send(
                        JSON.stringify({
                            op: 2,
                            d: {
                                // CRITICAL FIX: Discord requires the "Bot " prefix for the token.
                                token: `Bot ${discordToken}`,
                                properties: { os: "android", browser: "dcm", device: "dcm" },
                                intents: Number("33281")
                            }
                        })
                    );
                    logger.info("Authenticating...");
                }
                break;
            case GatewayOpcodes.Dispatch:
                if (t === GatewayDispatchEvents.Ready) {
                    resumeData = {
                        sessionId: d.session_id,
                        resumeGatewayUrl: `${d.resume_gateway_url}?v=10&encoding=json`,
                        seq: s
                    };
                    botId = d.user.id; // Store the bot's own ID
                    logger.info(`Logged in as ${d.user.username}${d.user.discriminator && Number(d.user.discriminator) !== 0 ? `#${d.user.discriminator}` : ""}. Bot ID: ${botId}`);
                
                    // NEW: Initialize the destinationWebhookIds list only once upon READY
                    if (destinationWebhookIds.length === 0 && ALL_DESTINATION_WEBHOOKS.length > 0) {
                        logger.info(`Fetching ${ALL_DESTINATION_WEBHOOKS.length} destination webhook IDs for smart loop prevention...`);
                        
                        // Extract the webhook ID from all destination URLs
                        for (const url of ALL_DESTINATION_WEBHOOKS) {
                            const id = getWebhookId(url);
                            if (id) {
                                destinationWebhookIds.push(id);
                                logger.debug(`Found destination webhook ID: ${id}`);
                            } else {
                                logger.error(`Failed to extract webhook ID from URL: ${url}`);
                            }
                        }
                        logger.info(`Smart loop prevention initialized with ${destinationWebhookIds.length} destination webhook IDs.`);
                    }
                }

                // Check if the message channel is one of our source channels
                if (t === GatewayDispatchEvents.MessageCreate && CHANNELS_TO_LISTEN.includes(d.channel_id)) {
                    let ext = "jpg";
                    let ub = " [USER]";

                    // Destructure d to get necessary properties
                    const { content, attachments, embeds, sticker_items, author, webhook_id, id: messageId } = d;
                    const authorId = author.id;
                    const channelId = d.channel_id; // Get the channel ID

                    // 1. Skip messages from our own bot. (Always do this first)
                    if (botId && authorId === botId) {
                        logger.debug(`Skipping message from self (${author.username}).`);
                        return;
                    }

                    // 2. CRITICAL: LOOP PREVENTION. 
                    if (webhook_id && destinationWebhookIds.includes(webhook_id)) {
                        logger.info(`LOOP PREVENTION: Skipping message from OWN webhook ID ${webhook_id}.`);
                        return;
                    }

                    // ==========================================================
                    // === CRITICAL LOGGING FOR DIAGNOSIS ===
                    // ==========================================================
                    logger.info(`--- Message Received ---`);
                    logger.info(`ID: ${messageId} | Channel: ${channelId}`);
                    logger.info(`Author ID: ${authorId} (Blocked? ${BLOCKED_USER_IDS.includes(authorId)})`);
                    logger.info(`Is Webhook: ${!!webhook_id}`);
                    logger.info(`Content Start: "${content?.substring(0, 50).replace(/\n/g, '\\n')}..."`);
                    if (webhook_id) {
                         logger.info(`PROXY/WEBHOOK DETECTED: Allowing message from external webhook ID ${webhook_id} to be mirrored.`);
                    }
                    // ==========================================================
                    
                    
                    // --- TARGETED BLOCK FILTER ---
                    if (BLOCKED_USER_IDS.includes(authorId) && !webhook_id) {
                        logger.info(`TARGETED BLOCK HIT: Skipping non-webhook command message from ${author.username}.`);
                        return;
                    }

                    // --- FALLBACK COMMAND/CONTENT FILTERS (Safety measures) ---
                    if (!webhook_id) {
                        const trimmedContent = content?.trim();
                        const lowerTrimmedContent = trimmedContent?.toLowerCase();
                        
                        // Check for explicit Tupperbox bracket syntax (e.g., [Name] message)
                        if (trimmedContent?.startsWith('[')) {
                             logger.info(`BRACKET-FILTER: Skipping likely Tupperbox bracket proxy command.`);
                             return;
                        }
                        
                        // Check for other common command prefixes
                        if (lowerTrimmedContent && (
                            lowerTrimmedContent.startsWith('!') || 
                            lowerTrimmedContent.startsWith('t!') || 
                            lowerTrimmedContent.startsWith('t?')
                        )) {
                             logger.info(`COMMAND-FILTER: Skipping likely prefixed command.`);
                             return;
                        }

                        // Check for empty message (often happens if Tupperbox instantly deletes the command)
                        const hasContent = trimmedContent && trimmedContent.length > 0;
                        const hasAttachments = attachments && attachments.length > 0;
                        const hasEmbeds = embeds && embeds.length > 0;
                        
                        if (!hasContent && !hasAttachments && !hasEmbeds) {
                             logger.info(`EMPTY CONTENT GUARD: Skipping message with no content (likely a deleted command).`);
                             return;
                        }
                    }
                    // --- END FALLBACK FILTERS ---

                    const { avatar, username, discriminator: discriminatorRaw, id } = author;
                    
                    // Calculate the discriminator suffix
                    let discriminatorSuffix = "";
                    if (discriminatorRaw && Number(discriminatorRaw) !== 0) {
                        discriminatorSuffix = `#${discriminatorRaw}`;
                    }

                    if (avatar?.startsWith("a_") ?? false) ext = "gif";
                    if (author.bot ?? false) ub = " [BOT]";


                    // ===============================================================
                    // === MIRRORING LOGIC ===
                    // ===============================================================
                    
                    const targetWebhooks: string[] | undefined = MIRROR_MAP[channelId];
                    
                    if (!targetWebhooks || targetWebhooks.length === 0) {
                        logger.info(`WARNING: No destination webhooks found for source channel ID ${channelId} in MIRROR_MAP. Skipping.`);
                        return;
                    }

                    // The loop runs for every destination webhook specified for this source channel.
                    for (const webhookUrl of targetWebhooks) {
                        logger.info(`=> MIRRORING message ID ${messageId} from ${channelId} to webhook: ${webhookUrl}`);
                        
                        const things: Things = {
                            avatarURL:
                                avatar ?? ""
                                    ? `https://cdn.discordapp.com/avatars/${id}/${avatar}.${ext}`
                                    : `https://cdn.discordapp.com/embed/avatars/${(BigInt(id) >> 22n) % 6n}.png`,
                            content: content ?? "** **\n",
                            url: webhookUrl, // Use the selected single URL
                            username: `${username}${discriminatorSuffix}${enableBotIndicator ? ub : ""}`
                        };

                        // FIX for Issue 1: Removed the conditional block that overrides the source profile.
                        // The 'useWebhookProfile' logic was incorrectly mixing the destination webhook's ID
                        // with the source profile data, causing the profile picture to fail loading.
                        if (useWebhookProfile) {
                            // We must fetch the webhook to get its default name, but we intentionally 
                            // skip overriding the avatarURL here to ensure impersonation works.
                            const webhookData = await fetch(webhookUrl, {
                                method: "GET",
                                headers
                            });
                            const tes: DiscordWebhook = (await webhookData.json()) as DiscordWebhook;
                            // Only override the username, maintaining the source avatar for impersonation
                            things.username = tes.name;
                        }
                        
                        if (embeds.length > 0) {
                            things.embeds = embeds;
                        } else if (sticker_items) {
                            things.files = sticker_items.map((a: APIStickerItem) => `https://media.discordapp.net/stickers/${a.id}.webp`);
                        } else if (attachments.length > 0) {
                            const fileSizeInBytes = Math.max(...attachments.map((a: APIAttachment) => a.size));
                            // Corrected the file size calculation (1024 * 1024)
                            const fileSizeInMegabytes = fileSizeInBytes / (1_024 * 1_024);
                            if (fileSizeInMegabytes < 8) {
                                things.files = attachments.map((a: APIAttachment) => a.url);
                            } else {
                                things.content += attachments.map((a: APIAttachment) => a.url).join("\n");
                            }
                        }
                        await executeWebhook(things);
                    }
                }
                break;
            case GatewayOpcodes.Reconnect: {
                logger.info("Reconnect request received. Reconnecting...");
                // FIX for Issue 2: Use the cleanup function
                disconnectAndListen();
                break;
            }
            case GatewayOpcodes.InvalidSession:
                logger.info("Invalid session.");
                if (d) {
                    logger.info("Can retry (d=true), reconnecting...");
                    // FIX for Issue 2: Use the cleanup function
                    disconnectAndListen();
                } else {
                    logger.error("Cannot retry (d=false), exiting...");
                    process.exit(1);
                }
                break;
            default:
                logger.debug(`Unhandled opcode: ${op}`);
                break;
        }
    });
};

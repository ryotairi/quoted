import client from "./services/matrix";
import config from "./services/config";
import createImage from "./utils/createImage";
import { readFileSync, mkdirSync, existsSync } from "fs";
import sharp from "sharp";
import { RoomEvent, RoomMemberEvent, Direction } from "matrix-js-sdk";
import createFileId from "./utils/createFileId";
import { createLogger } from "./utils/logger";

const log = createLogger("bot");

// Resolve a raw event to its latest edited content (m.replace). Returns the event
// unchanged if it was never edited or the lookup fails.
async function applyLatestEdit(roomId: string, ev: any): Promise<any> {
  const id = ev?.event_id;
  if (!id || !ev?.content) return ev;
  try {
    const res: any = await client.relations(roomId, id, "m.replace");
    const edits = res?.events ?? [];
    if (!edits.length) return ev;
    const newest = edits.reduce((a: any, b: any) =>
      (b.getTs?.() ?? 0) > (a.getTs?.() ?? 0) ? b : a,
    );
    const nc = newest.getContent?.()?.["m.new_content"];
    if (nc) {
      log.debug(`Applying latest edit to ${id}`);
      // Keep the original relations (e.g. reply); override body/formatting from the edit.
      return { ...ev, content: { ...ev.content, ...nc } };
    }
  } catch (e) {
    log.debug(`edit lookup failed for ${id}: ${String(e).slice(0, 80)}`);
  }
  return ev;
}

// Ensure tmp directory exists
if (!existsSync("tmp")) mkdirSync("tmp", { recursive: true });

const startTime = Date.now();
log.info(
  `Quoted-Matrix starting – userId=${config.matrix.userId}, animatedStickers=${config.render.animatedStickers}, transparentBg=${config.render.transparentBackground}`,
);

// Auto-join rooms on invite
client.on(RoomMemberEvent.Membership, async (event, member) => {
  if (event.localTimestamp < startTime) return;
  if (
    member.membership === "invite" &&
    member.userId === config.matrix.userId
  ) {
    log.info(`Invited to room ${member.roomId}, joining…`);
    try {
      await client.joinRoom(member.roomId);
      log.info(`Joined ${member.roomId}`);
    } catch (err) {
      log.error(`Failed to join room ${member.roomId}:`, err);
    }
    try {
      await client.sendHtmlNotice(
        member.roomId,
        config.welcomeText,
        config.welcomeText,
      );
    } catch (err) {
      log.error(`Failed to send welcome to ${member.roomId}:`, err);
    }
  }
});

client.on(RoomEvent.Timeline, async (event, room, toStartOfTimeline) => {
  if (toStartOfTimeline) return;
  if (event.localTimestamp < startTime) return;
  if (event.getType() !== "m.room.message") return;

  const sender = event.getSender();
  if (sender === config.matrix.userId) return;

  const content = event.getContent();
  if (content.msgtype !== "m.text") return;

  const prefix = (config as any).commandPrefix || "..";
  const quoteCmd = `${prefix}${(config as any).commands?.quote || "q"}`;
  const helpCmd = `${prefix}${(config as any).commands?.help || "help"}`;

  // Strip Matrix reply fallback ("> quote\n\n actual message" added by clients)
  let body = (content.body || "").trim();
  if (body.startsWith("> ")) {
    const sep = body.indexOf("\n\n");
    if (sep !== -1) body = body.slice(sep + 2).trim();
  }
  if (!body.startsWith(prefix)) return;

  const args = body.slice(prefix.length).trim().split(/\s+/);
  const cmdName = args.shift() || "";

  const fullCmd = prefix + cmdName;

  if (fullCmd === quoteCmd) {
    const replyTo = content["m.relates_to"]?.["m.in_reply_to"]?.event_id;
    if (typeof replyTo !== "string") {
      await client.sendHtmlNotice(
        room.roomId,
        "",
        "<b>Please reply to a message!</b>",
      );
      return;
    }

    let hideReplies = false;
    let count = 0;
    for (const arg of args) {
      if (arg === "-c") {
        hideReplies = true;
        continue;
      }
      const parsedCount = parseInt(arg, 10);
      if (!isNaN(parsedCount) && parsedCount > 0)
        count = Math.min(parsedCount, 20);
    }

    log.info(
      `Quote request in ${room.roomId} – replyTo=${replyTo} count=${count} hideReplies=${hideReplies}`,
    );

    let processingId: string | undefined;
    try {
      if (count > 10) {
        await client.sendNotice(
          room.roomId,
          `${count} is too large! Maximum is 10`,
        );
        return;
      }

      // Acknowledge immediately; this message is later edited into the finished quote.
      const processing = await client.sendEvent(room.roomId, "m.room.message", {
        msgtype: "m.notice",
        body: "⏳ Generating quote…",
        format: "org.matrix.custom.html",
        formatted_body: "⏳ <i>Generating quote…</i>",
        "m.relates_to": { "m.in_reply_to": { event_id: event.getId() } },
      } as any);
      processingId = (processing as any).event_id;

      const replyToEvent = await client.fetchRoomEvent(room.roomId, replyTo);
      const allEvents = [replyToEvent];

      if (count > 0) {
        let timeline = room.getTimelineForEvent(replyTo);
        if (!timeline) {
          for (const set of room.getTimelineSets()) {
            timeline = await client.getEventTimeline(set, replyTo);
          }
        }
        const index = timeline
          .getEvents()
          .findIndex((x) => x.getId() == replyTo);
        const events = timeline.getEvents();
        for (let i = index + 1; i <= index + count; i++) {
          try {
            if (events[i]) allEvents.push(events[i].event);
          } catch {}
        }
      }

      // Apply the latest edit (m.replace) to each event so quotes reflect the current
      // message text, not the original a user has since edited.
      const resolvedEvents = await Promise.all(
        allEvents.map((e) => applyLatestEdit(room.roomId, e)),
      );

      log.debug(`Rendering ${resolvedEvents.length} event(s)…`);
      const filePath = await createImage(resolvedEvents, { hideReplies });
      const imageData = readFileSync(filePath);

      // createImage returns .png for a static quote, or .webp/.gif/.mp4 when the
      // quote contains animated media.
      const ext = filePath.split(".").pop()!.toLowerCase();
      const isAnimated = ext !== "png";
      const mimeByExt: Record<string, string> = {
        png: "image/png",
        webp: "image/webp",
        gif: "image/gif",
        mp4: "video/mp4",
      };
      const mime = mimeByExt[ext] || "image/png";
      const fileName = isAnimated ? `quote.${ext}` : "sticker.png";

      const info: any = { mimetype: mime, size: imageData.length };
      try {
        if (ext !== "mp4") {
          const dim = await sharp(imageData).metadata();
          if (dim.width) info.w = dim.width;
          const h = dim.pageHeight || dim.height;
          if (h) info.h = h;
        }
      } catch {}

      log.info(
        `Uploading ${fileName} ${(imageData.length / 1024).toFixed(1)}KB …`,
      );
      const uploadResponse = await client.uploadContent(imageData, {
        name: fileName,
        type: mime,
      });
      const mxcUrl = uploadResponse.content_uri;
      log.info(`Uploaded → ${mxcUrl}`);

      if (isAnimated) {
        // Animated output: edit the "processing" message in-place.
        // mp4 is real video → m.video; gif/webp animate as images → m.image.
        const msgtype = ext === "mp4" ? "m.video" : "m.image";
        const media: any = { msgtype, body: fileName, url: mxcUrl, info };
        await client.sendEvent(room.roomId, "m.room.message", {
          ...media,
          "m.new_content": media,
          "m.relates_to": { rel_type: "m.replace", event_id: processingId },
        } as any);
        log.success(`animated quote (${ext}, ${msgtype}) published via edit in ${room.roomId}`);
        return; // animated quotes aren't added to the sticker pack
      }

      // Static output: drop the "processing" message and send a native m.sticker.
      if (processingId) await client.redactEvent(room.roomId, processingId).catch(() => {});
      // @ts-ignore m.sticker is a valid event type
      await client.sendEvent(room.roomId, "m.sticker", {
        body: fileName,
        info,
        url: mxcUrl,
        "m.relates_to": { "m.in_reply_to": { event_id: event.getId() } },
      });
      log.success(`sticker quote published in ${room.roomId}`);

      const id = createFileId(allEvents);
      const state = room.getLiveTimeline().getState(Direction.Forward);
      const roomEmotes =
        state.getStateEvents("im.ponies.room_emotes", "quoted")?.getContent() ??
        {};
      const images =
        roomEmotes && typeof roomEmotes.images === "object"
          ? roomEmotes.images
          : {};
      const pack =
        roomEmotes && typeof roomEmotes.pack === "object"
          ? roomEmotes.pack
          : null;
      if (images[id]) {
        log.debug(`Sticker ${id} already in pack, skipping state event`);
        return;
      }
      images[id] = {
        url: mxcUrl,
        info: { mimetype: mime, size: imageData.length },
      };

      if (state.mayClientSendStateEvent("im.ponies.room_emotes", client)) {
        // @ts-ignore
        await client.sendStateEvent(
          room.roomId,
          "im.ponies.room_emotes",
          {
            images,
            pack: pack ?? { display_name: "Quoted", usage: ["sticker"] },
          },
          "quoted",
        );
        log.info(`Added sticker ${id} to room pack`);
      } else {
        log.warn(
          `No permission to send im.ponies.room_emotes in ${room.roomId}`,
        );
        client
          .sendHtmlNotice(
            room.roomId,
            "",
            '<i>Could not create "Quoted" sticker pack, can\'t send state event "im.ponies.room_emotes"</i>',
          )
          .catch(() => {});
      }
    } catch (err) {
      log.fail(
        `quote generation failed in ${room.roomId}: ${String(err).slice(0, 160)}`,
      );
      const errBody = "❌ Failed to create quote.";
      const errHtml = "❌ <b>Failed to create quote.</b>";
      if (processingId) {
        // Edit the "processing" message into the error so we don't spam the room.
        const errContent = { msgtype: "m.notice", body: errBody, format: "org.matrix.custom.html", formatted_body: errHtml };
        client
          .sendEvent(room.roomId, "m.room.message", {
            ...errContent,
            "m.new_content": errContent,
            "m.relates_to": { rel_type: "m.replace", event_id: processingId },
          } as any)
          .catch(() => {});
      } else {
        client.sendHtmlNotice(room.roomId, errBody, errHtml).catch(() => {});
      }
    }
  } else if (fullCmd === helpCmd) {
    client
      .sendHtmlNotice(room.roomId, config.helpText, config.helpText)
      .catch((e) => log.error("help send failed", e));
  }
});

client.startClient({ initialSyncLimit: 0 }).then(() => {
  log.info("Matrix client ready!");
});

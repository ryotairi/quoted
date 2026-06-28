import sanitize from "sanitize-html";
import client from "../services/matrix";
import config from "../services/config";

export function transformImgSrc(srcUrl: string, thumbnail: boolean): string {
  if (!srcUrl) return "";

  // Matrix MXC URLs
  if (srcUrl.startsWith("mxc://")) {
    const parts = srcUrl.replace("mxc://", "").split("/");
    const serverName = parts[0];
    // Strip URL fragments (#...) from mediaId
    const mediaId = parts.slice(1).join("/").split("#")[0];
    try {
      // Auth is via Authorization: Bearer header in downloadFile, not query param
      if (thumbnail) {
        return `${config.matrix.homeserverUrl}/_matrix/client/v1/media/thumbnail/${serverName}/${mediaId}?width=64&height=64&method=scale`;
      } else {
        return `${config.matrix.homeserverUrl}/_matrix/client/v1/media/download/${serverName}/${mediaId}`;
      }
    } catch {
      return srcUrl;
    }
  }

  // Pass through http(s), data: and file: URLs unchanged
  return srcUrl;
}

const allowedTags = sanitize.defaults.allowedTags.concat([
  "img",
  "span",
  "del",
  "br",
  "font",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "pre",
]);

const allowedAttributes: Record<string, string[]> = {
  ...sanitize.defaults.allowedAttributes,
  img: [
    "src",
    "alt",
    "title",
    "width",
    "height",
    "class",
    "data-mx-emoticon",
    "data-mx-*",
    "style",
  ],
  span: [
    "data-mx-spoiler",
    "data-mx-color",
    "data-mx-bg-color",
    "class",
    "style",
  ],
  a: ["href", "name", "target", "rel"],
  code: ["class"],
  font: ["color", "data-mx-color", "data-mx-bg-color"],
  ol: ["start"],
  pre: ["class"],
};

export function sanitizeEventHtml(dirty: string): string {
  return sanitize(dirty, {
    allowedTags,
    allowedAttributes,
    allowedSchemes: ["mxc", "http", "https", "data"],
    allowedSchemesByTag: {
      img: ["mxc", "http", "https", "data"],
    },
    exclusiveFilter: function (frame) {
      // Strip out <mx-reply> and all its contents completely
      return frame.tag === "mx-reply";
    },
    transformTags: {
      img: (tagName, attribs) => {
        const isEmoji =
          "data-mx-emoticon" in attribs ||
          (attribs.class && /emoji|emoticon|custom-emoji/i.test(attribs.class));
        const newAttribs: any = {
          ...attribs,
          // Always request the ORIGINAL (thumbnail=false): server thumbnails flatten
          // alpha → black, which ruins transparent emoji/inline images.
          src: attribs.src ? transformImgSrc(attribs.src, false) : "",
        };
        // Ensure emoji size is reasonable if not specified
        if (isEmoji && !newAttribs.width) {
          newAttribs.width = "20";
          newAttribs.height = "20";
        }
        return {
          tagName,
          attribs: newAttribs,
        };
      },
    },
  });
}

// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

export type Media = ArrayBuffer | Blob | ArrayBufferView;

export function byteLength(media: Media): number {
    return typeof Blob !== "undefined" && media instanceof Blob ? media.size : (media as ArrayBufferView).byteLength;
}

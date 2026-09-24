import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { TaskPhoto } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The photos on a card: one image on its own, or a carousel when there are
 * several.
 *
 * The caption under each is the chat message it arrived in, not the filename:
 * "Keyboard not closing on tap outside" is what says what a screenshot is of,
 * and `00003005-PHOTO-….jpg` says nothing. Clicking the image opens it full size
 * in a new tab, because a phone screenshot squeezed into a dialog is often too
 * small to read the bug in.
 */
export function PhotoCarousel({ photos }: { photos: TaskPhoto[] }) {
  const [index, setIndex] = useState(0);
  const count = photos.length;

  // A card switched under the dialog, or a photo unlinked, must not leave the
  // index pointing past the end.
  useEffect(() => {
    setIndex((current) => (current >= count ? 0 : current));
  }, [count]);

  if (count === 0) return null;
  const photo = photos[Math.min(index, count - 1)]!;
  const url = api.whatsappMediaUrl(photo.mediaId);
  const many = count > 1;
  const go = (step: number) => setIndex((current) => (current + step + count) % count);

  return (
    <div
      className="space-y-2 outline-none"
      tabIndex={many ? 0 : undefined}
      onKeyDown={(event) => {
        if (!many) return;
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          go(-1);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          go(1);
        }
      }}
      aria-roledescription={many ? "carousel" : undefined}
      aria-label={many ? `${count} photos from the chat` : undefined}
    >
      <div className="group relative overflow-hidden rounded-md border border-border/60 bg-surface/60">
        <a href={url} target="_blank" rel="noreferrer" title="Open full size" className="block">
          <img
            key={photo.mediaId}
            src={url}
            alt={photo.caption ?? photo.filename}
            className="mx-auto max-h-[26rem] w-auto object-contain"
            loading="lazy"
          />
        </a>

        <span className="pointer-events-none absolute right-2 top-2 inline-flex items-center gap-1 rounded bg-background/80 px-1.5 py-0.5 text-[10.5px] text-muted-foreground opacity-0 backdrop-blur transition-opacity group-hover:opacity-100">
          <ExternalLink className="size-2.5" /> full size
        </span>

        {many ? (
          <>
            <button
              type="button"
              onClick={() => go(-1)}
              aria-label="Previous photo"
              className="absolute left-2 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-full border border-border/70 bg-background/85 text-foreground shadow-sm backdrop-blur transition-colors hover:bg-muted"
            >
              <ChevronLeft className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => go(1)}
              aria-label="Next photo"
              className="absolute right-2 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-full border border-border/70 bg-background/85 text-foreground shadow-sm backdrop-blur transition-colors hover:bg-muted"
            >
              <ChevronRight className="size-4" />
            </button>
            <span className="absolute bottom-2 right-2 rounded-full bg-background/85 px-2 py-0.5 text-[10.5px] font-medium tabular-nums text-foreground backdrop-blur">
              {index + 1} / {count}
            </span>
          </>
        ) : null}
      </div>

      <p className="text-[12.5px] leading-relaxed">
        {photo.caption ? <span className="text-card-foreground">{photo.caption}</span> : null}
        <span className={cn("text-muted-foreground", photo.caption && "ml-1.5")}>
          {[photo.author, photo.sentAt ? formatDateTime(photo.sentAt) : null].filter(Boolean).join(" · ")}
        </span>
      </p>

      {many ? (
        <div className="flex gap-1.5 overflow-x-auto pb-0.5 scrollbar-slim">
          {photos.map((entry, position) => (
            <button
              key={entry.mediaId}
              type="button"
              onClick={() => setIndex(position)}
              aria-label={`Photo ${position + 1}`}
              aria-current={position === index}
              className={cn(
                "size-12 shrink-0 overflow-hidden rounded border transition-opacity",
                position === index ? "border-primary opacity-100" : "border-border/60 opacity-60 hover:opacity-100",
              )}
            >
              <img src={api.whatsappMediaUrl(entry.mediaId)} alt="" className="size-full object-cover" loading="lazy" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

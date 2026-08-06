import GLightbox from "glightbox";
import "glightbox/dist/css/glightbox.css";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { distributeColumns } from "../utils/distributeColumns.js";
import { sortPhotos } from "../utils/sortPhotos.js";

declare global {
  interface Window {
    _glightboxInstance?: ReturnType<typeof GLightbox>;
  }
}

type Photo = {
  id: string;
  imageUrl: string;
  thumbBase: string;
  ratio: number;
  width?: number | null;
  height?: number | null;
  title?: string;
  caption?: string;
  author?: string;
  body?: string;
  date?: string;
};

type Tile = Photo & { index: number };

const BATCH_SIZE = 10;
const INITIAL_COUNT = 20;
const EAGER_COUNT = 6;
const PRIORITY_COUNT = 3;
const MAX_RETRIES = 2;
const MAX_STAGGER = 12;
const STAGGER_STEP = 0.05;
const FALLBACK_RATIO = 16 / 9;

function columnsForWidth() {
  if (typeof window === "undefined") return 3;
  if (window.matchMedia("(min-width: 1000px)").matches) return 3;
  if (window.matchMedia("(min-width: 640px)").matches) return 2;
  return 1;
}

function slideTitle(photo: Photo) {
  return photo.caption?.trim() || photo.body?.trim() || photo.title?.trim() || "";
}

// ponytail: fixed ratio list instead of measuring anything — the skeleton only
// has to read as "photos are coming", not predict the actual grid.
const SKELETON_RATIOS = [16 / 9, 3 / 4, 4 / 3, 1, 16 / 10, 3 / 4, 3 / 2, 1, 4 / 5, 16 / 9, 4 / 3, 1];

function SkeletonGrid({ cols }: { cols: number }) {
  const tiles = SKELETON_RATIOS.map((ratio, index) => ({ ratio, index }));
  return (
    <div class="masonry" role="status" aria-busy="true" aria-label="Loading gallery">
      {distributeColumns(tiles, cols).map((column, columnIndex) => (
        <div class="masonry-col" key={columnIndex}>
          {column.map((tile) => (
            <div
              key={tile.index}
              class="photo photo-skeleton"
              style={{
                aspectRatio: `${tile.ratio}`,
                "--card-delay": `${Math.min(tile.index, MAX_STAGGER) * STAGGER_STEP}s`,
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function Loader({ label }: { label: string }) {
  return (
    <div class="photo-grid-loader">
      <svg width="40" height="40" viewBox="0 0 48 48" aria-hidden="true">
        <circle
          cx="24"
          cy="24"
          r="20"
          stroke="currentColor"
          strokeWidth="3"
          fill="none"
          strokeDasharray="100"
          strokeDashoffset="60"
        >
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 24 24"
            to="360 24 24"
            dur="1s"
            repeatCount="indefinite"
          />
        </circle>
      </svg>
      <span>{label}</span>
    </div>
  );
}

export default function PhotoGridClient({
  staffAuthors,
  ariaLabelPrefix,
}: {
  staffAuthors?: string[];
  ariaLabelPrefix?: string;
}) {
  const [originalPhotos, setOriginalPhotos] = useState<Photo[]>([]);
  const [sortOption, setSortOption] = useState(getInitialSort());
  const [shuffleNonce, setShuffleNonce] = useState(0);
  const [loading, setLoading] = useState(true);
  const [flashing, setFlashing] = useState(false);
  const [visibleCount, setVisibleCount] = useState(INITIAL_COUNT);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [pendingBatch, setPendingBatch] = useState(false);
  const [pendingHashId, setPendingHashId] = useState<string | null>(null);
  const [lightboxReady, setLightboxReady] = useState(false);
  const [gridKey, setGridKey] = useState(0);
  const [cols, setCols] = useState(columnsForWidth);
  const [retries, setRetries] = useState<Record<string, number>>({});

  // Derived, not state: if `sortOption` and the sorted list could disagree for even
  // one render, the entrance delays would freeze against the pre-sort order.
  // `shuffleNonce` is a dependency only so re-picking "random" re-shuffles.
  const loadedPhotos = useMemo(
    () => sortPhotos(originalPhotos, sortOption),
    [originalPhotos, sortOption, shuffleNonce],
  );

  const sentinelRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  // Entrance state lives in refs on purpose: a re-render must never restart or
  // cut off a running card-in animation.
  const batchStartRef = useRef(0);
  const delaysRef = useRef(new Map<string, number>());
  const revealedRef = useRef(new Set<string>());
  const imgLoadedRef = useRef(new Set<string>());

  function resetEntranceState() {
    batchStartRef.current = 0;
    delaysRef.current.clear();
    revealedRef.current.clear();
    imgLoadedRef.current.clear();
  }

  // Delay is computed once per card and then frozen, so later renders keep it stable.
  function delayFor(id: string, index: number) {
    const known = delaysRef.current.get(id);
    if (known !== undefined) return known;
    const offset = Math.min(Math.max(index - batchStartRef.current, 0), MAX_STAGGER);
    const delay = offset * STAGGER_STEP;
    delaysRef.current.set(id, delay);
    return delay;
  }

  function handleImageError(id: string, attempt: number) {
    // Bump the retry counter, which re-renders with a `?r=n` cache-buster on src *and*
    // srcset - mutating img.src alone is a no-op while srcset wins the candidate pick.
    const bump = () => setRetries((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
    if (attempt >= MAX_RETRIES) bump();
    else setTimeout(bump, 2000);
  }

  // Show notification overlay inside GLightbox
  function showNotification(message: string, type: "success" | "error") {
    const container = document.querySelector(".glightbox-container");
    if (!container) return;

    const notification = document.createElement("div");
    notification.className = `glightbox-notification glightbox-notification-${type}`;
    notification.textContent = message;
    container.appendChild(notification);

    setTimeout(() => notification.classList.add("show"), 100);
    setTimeout(() => {
      notification.classList.remove("show");
      setTimeout(() => notification.remove(), 300);
    }, 3000);
  }

  // Add custom share and view buttons to GLightbox
  // biome-ignore lint/suspicious/noExplicitAny: GLightbox has no public type for currentIndex
  function addCustomButtonsToContainer(lightbox: any) {
    document.querySelectorAll(".custom-glightbox-btns").forEach((el) => el.remove());

    const container = document.querySelector(".gcontainer");
    if (container && !container.querySelector(".custom-glightbox-btns")) {
      const btnContainer = document.createElement("div");
      btnContainer.className = "custom-glightbox-btns";
      btnContainer.style.opacity = "0";

      // Share button: copies direct link to current image with its unique ID
      const shareBtn = document.createElement("button");
      shareBtn.className = "glightbox-btn glightbox-share-btn";
      shareBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>`;
      shareBtn.title = "Share";
      shareBtn.onclick = (event) => {
        event.stopPropagation();
        event.preventDefault();

        let slideIndex = typeof lightbox.currentIndex === "number" ? lightbox.currentIndex : -1;
        if (slideIndex < 0) {
          const activeSlide = document.querySelector(".gslide.current");
          const allSlides = Array.from(document.querySelectorAll(".gslide"));
          slideIndex = activeSlide ? allSlides.indexOf(activeSlide) : -1;
        }

        const photoObj = slideIndex >= 0 ? loadedPhotos[slideIndex] : undefined;
        const photoId = photoObj?.id || "";

        const pageUrl =
          window.location.origin + window.location.pathname + (photoId ? `#img-${photoId}` : "");

        try {
          navigator.clipboard.writeText(pageUrl);
          showNotification("Link copied! Share this to open the image in lightbox.", "success");
        } catch {
          showNotification(`Failed to copy link. Please copy manually: ${pageUrl}`, "error");
        }
      };

      // View original button: opens the original image in a new tab
      const viewBtn = document.createElement("button");
      viewBtn.className = "glightbox-btn glightbox-view-btn";
      viewBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
      viewBtn.title = "View original";
      viewBtn.onclick = (event) => {
        event.stopPropagation();
        event.preventDefault();
        const activeSlide = document.querySelector(".gslide.current");
        const img = activeSlide?.querySelector(".gslide-image img");
        if (img instanceof HTMLImageElement) {
          window.open(img.src, "_blank");
        } else {
          showNotification("Unable to open original image.", "error");
        }
      };

      btnContainer.appendChild(shareBtn);
      btnContainer.appendChild(viewBtn);
      container.appendChild(btnContainer);

      requestAnimationFrame(() => {
        btnContainer.style.opacity = "1";
      });
    }
  }

  // Load images on mount & refresh
  async function loadAndSetPhotos() {
    setLoading(true);
    setFlashing(true);
    setOriginalPhotos([]);
    setTimeout(() => setFlashing(false), 200);
    try {
      // @ts-ignore
      const { default: loadImages } = await import("../../scripts/load-images.js");
      const loaded = await loadImages();
      // biome-ignore lint/suspicious/noExplicitAny: raw images.json entries
      const mapped: Photo[] = loaded.map((img: any) => ({
        id: img.id,
        imageUrl: img.imageUrl,
        thumbBase: `/images/thumbs/${img.id}${img.isDefault ? "-default" : ""}`,
        width: img.width || null,
        height: img.height || null,
        // Fallback covers cached images.json files written before width/height existed.
        ratio: img.width && img.height ? img.width / img.height : FALLBACK_RATIO,
        title: img.title || img.id,
        caption: img.caption || "",
        author: img.author || "",
        body: img.body || "",
        date: img.date,
      }));
      resetEntranceState();
      setRetries({});
      setOriginalPhotos(mapped);
      setVisibleCount(INITIAL_COUNT);

      // PhotoGrid.astro rendert denselben Grid statisch vor - sonst enthaelt das
      // HTML wegen client:only kein einziges <img> und Crawler sehen eine leere
      // Seite. Ab hier uebernimmt diese Komponente. Erst nach setOriginalPhotos
      // entfernen, sonst klafft dazwischen eine leere Seite.
      document.querySelector("[data-static-grid]")?.remove();
    } catch (err) {
      console.error("[PhotoGridClient] Error loading photos:", err);
    }
    setLoading(false);
  }

  useEffect(() => {
    loadAndSetPhotos();
  }, []);

  useEffect(() => {
    const update = () => setCols(columnsForWidth());
    const queries = [
      window.matchMedia("(min-width: 1000px)"),
      window.matchMedia("(min-width: 640px)"),
    ];
    for (const q of queries) q.addEventListener("change", update);
    return () => {
      for (const q of queries) q.removeEventListener("change", update);
    };
  }, []);

  useEffect(() => {
    const handleSort = (e: CustomEvent) => {
      resetEntranceState();
      setSortOption(e.detail.sortOption);
      setVisibleCount(INITIAL_COUNT);
      setPendingBatch(false);
      setIsLoadingMore(false);
      setGridKey((prev) => prev + 1);
      // Re-picking "random" has to produce a new shuffle.
      if (e.detail.sortOption === "random") setShuffleNonce((prev) => prev + 1);
    };
    window.addEventListener("sortGallery", handleSort as EventListener);
    return () => window.removeEventListener("sortGallery", handleSort as EventListener);
  }, []);

  useEffect(() => {
    const handleRefresh = () => loadAndSetPhotos();
    window.addEventListener("refreshGallery", handleRefresh);
    return () => window.removeEventListener("refreshGallery", handleRefresh);
  }, []);

  // Hash: Check on mount if we need to open a specific image
  useEffect(() => {
    const hash = window.location.hash;
    if (hash.startsWith("#img-")) {
      setPendingHashId(hash.replace("#img-", ""));
    }
  }, []);

  // Infinite Scroll: robust Observer, feuert nur einmal pro Batch
  useEffect(() => {
    if (!sentinelRef.current) return;
    if (observerRef.current) observerRef.current.disconnect();

    observerRef.current = new IntersectionObserver(
      (entries) => {
        if (
          entries[0].isIntersecting &&
          !isLoadingMore &&
          !pendingBatch &&
          visibleCount < loadedPhotos.length
        ) {
          setIsLoadingMore(true);
          setPendingBatch(true);
          setTimeout(() => {
            setVisibleCount((prev) => {
              // New cards stagger relative to the batch they arrived in, not to a
              // modulo of their global index.
              batchStartRef.current = prev;
              return Math.min(prev + BATCH_SIZE, loadedPhotos.length);
            });
            setIsLoadingMore(false);
            setPendingBatch(false);
          }, 150);
        }
      },
      { rootMargin: "200px" },
    );
    observerRef.current.observe(sentinelRef.current);

    return () => {
      if (observerRef.current) observerRef.current.disconnect();
    };
  }, [isLoadingMore, pendingBatch, visibleCount, loadedPhotos.length]);

  const visiblePhotos = loadedPhotos.slice(0, visibleCount);

  // GLightbox: driven by an explicit element list, because the DOM order of the
  // masonry columns no longer matches the sort order.
  useEffect(() => {
    if (visiblePhotos.length === 0) return;
    setLightboxReady(false);
    if (window._glightboxInstance) window._glightboxInstance.destroy();
    const lightbox = GLightbox({
      // GLightbox types `elements` as the empty tuple `[]`, so the cast is unavoidable.
      elements: visiblePhotos.map((photo) => ({
        href: photo.imageUrl,
        type: "image",
        title: slideTitle(photo),
        description: `Author: ${photo.author}`,
      })) as unknown as [],
      touchNavigation: true,
      zoomable: false,
      openEffect: "fade",
      closeEffect: "fade",
      slideEffect: "slide",
    });

    lightbox.on("open", () => {
      addCustomButtonsToContainer(lightbox);
    });
    lightbox.on("slide_changed", () => {
      addCustomButtonsToContainer(lightbox);
    });
    lightbox.on("close", () => {
      document.querySelectorAll(".custom-glightbox-btns").forEach((el) => el.remove());
    });

    window._glightboxInstance = lightbox;
    setTimeout(() => setLightboxReady(true), 100); // Mark GLightbox as ready after init
  }, [loadedPhotos, visibleCount]);

  // Hash-Open: Open only once and only if GLightbox is ready and not already open
  useEffect(() => {
    if (!pendingHashId || !lightboxReady) return;
    const index = loadedPhotos.findIndex((photo) => photo.id === pendingHashId);
    if (
      index >= 0 &&
      index < visibleCount &&
      window._glightboxInstance &&
      typeof window._glightboxInstance.openAt === "function"
    ) {
      // Öffne das Bild nur, wenn die Lightbox nicht bereits offen ist
      if (!document.querySelector(".glightbox-open")) {
        setTimeout(() => {
          if (window._glightboxInstance) {
            window._glightboxInstance.openAt(index);
            setPendingHashId(null);
          }
        }, 200);
      }
    } else if (index >= visibleCount && index >= 0) {
      setVisibleCount((prev) => {
        batchStartRef.current = prev;
        return index + 1;
      });
    }
  }, [pendingHashId, loadedPhotos, visibleCount, lightboxReady]);

  function isStaffPhoto(photo: Photo) {
    return (
      staffAuthors?.some(
        (staff) => staff.trim().toLowerCase() === (photo.author?.trim().toLowerCase() || ""),
      ) ?? false
    );
  }

  function renderTile(photo: Tile) {
    const attempt = retries[photo.id] ?? 0;
    const failed = attempt > MAX_RETRIES;
    const bust = attempt > 0 ? `?r=${attempt}` : "";
    const src = `${photo.thumbBase}-400.webp${bust}`;
    const staff = isStaffPhoto(photo);
    const classes = [
      "photo",
      staff && "staff-photo",
      revealedRef.current.has(photo.id) && "shown",
      imgLoadedRef.current.has(photo.id) && "loaded",
      failed && "is-error",
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <a
        key={photo.id}
        class={classes}
        style={{
          aspectRatio: `${photo.ratio}`,
          "--card-delay": `${delayFor(photo.id, photo.index)}s`,
        }}
        href={photo.imageUrl}
        data-id={photo.id}
        aria-label={`${ariaLabelPrefix} ${photo.title}`}
        onClick={(event) => {
          event.preventDefault();
          window._glightboxInstance?.openAt(photo.index);
        }}
        onAnimationEnd={() => revealedRef.current.add(photo.id)}
      >
        {failed ? (
          <span class="photo-unavailable">Image unavailable</span>
        ) : (
          <img
            src={src}
            srcSet={[200, 400, 800]
              .map((w) => `${photo.thumbBase}-${w}.webp${bust} ${w}w`)
              .join(", ")}
            sizes="(max-width: 639px) 100vw, (max-width: 999px) 48vw, 370px"
            width={photo.width ?? undefined}
            height={photo.height ?? undefined}
            alt={photo.title}
            loading={photo.index < EAGER_COUNT ? "eager" : "lazy"}
            fetchPriority={photo.index < PRIORITY_COUNT ? "high" : "auto"}
            decoding="async"
            onLoad={(event) => {
              imgLoadedRef.current.add(photo.id);
              event.currentTarget.closest(".photo")?.classList.add("loaded");
            }}
            onError={() => handleImageError(photo.id, attempt)}
          />
        )}
        <span class="photo-caption">
          <span class="photo-caption-title">{photo.title}</span>
          {photo.author && <span class="photo-caption-author">{photo.author}</span>}
        </span>
        {staff && (
          <span class="staff-badge" title="Staff member">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <polygon points="12,3 15,10 22,10 17,14 19,21 12,17 5,21 7,14 2,10 9,10" />
            </svg>
          </span>
        )}
      </a>
    );
  }

  const columns = distributeColumns<Tile>(
    visiblePhotos.map((photo, index) => ({ ...photo, index })),
    cols,
  );

  return (
    <div>
      {loading ? (
        <SkeletonGrid cols={cols} />
      ) : (
        <div key={gridKey} id="photo-grid" class={`masonry ${flashing ? "flashing" : ""}`}>
          {columns.map((column, columnIndex) => (
            <div class="masonry-col" key={columnIndex}>
              {column.map(renderTile)}
            </div>
          ))}
        </div>
      )}
      {isLoadingMore && <Loader label="Loading more images..." />}
      <div ref={sentinelRef} />
    </div>
  );
}

function getInitialSort(defaultSort = "date-desc") {
  if (typeof window !== "undefined") {
    const stored = window.localStorage.getItem("gallerySortOption");
    if (stored) return stored;
    if (window.__gallerySortOption) return window.__gallerySortOption;
  }
  return defaultSort;
}

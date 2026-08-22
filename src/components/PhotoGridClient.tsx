import GLightbox from "glightbox";
import "glightbox/dist/css/glightbox.css";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
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

// Beim ersten Aufruf der Komponente steht der statische Grid noch, und seine
// card-in-Animation laeuft. Die Web Animations API sagt, wie weit sie ist; als
// negativer animation-delay gesetzt, nehmen die Karten der Komponente die
// Einblendung an genau derselben Stelle wieder auf, statt sie abzuschneiden.
// null heisst: nichts abzulesen (Animation durch, reduzierte Bewegung, kein
// statischer Grid) - dann sind die Karten schlicht fertig eingeblendet.
function runningCardInDelay(): number | null {
  const card = document.querySelector("[data-static-grid] .photo");
  const anim = card
    ?.getAnimations?.()
    .find((a) => (a as CSSAnimation).animationName === "card-in");
  const elapsed = Number(anim?.currentTime);
  const total = Number(anim?.effect?.getTiming?.().duration);
  if (!Number.isFinite(elapsed) || !Number.isFinite(total) || elapsed <= 0 || elapsed >= total) {
    return null;
  }
  return -elapsed / 1000;
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

export default function PhotoGridClient({
  initialPhotos = [],
  staffAuthors,
  ariaLabelPrefix,
}: {
  initialPhotos?: Photo[];
  staffAuthors?: string[];
  ariaLabelPrefix?: string;
}) {
  // Derselbe Bestand, den PhotoGrid.astro statisch rendert, als Prop: images.json
  // wird in das Docker-Image gebacken, ein fetch beim Seitenaufruf holt also
  // garantiert dieselben Daten - und schiebt dafuer einen Skeleton zwischen zwei
  // identische Frames. Nachgeholt wird nur noch auf Knopfdruck.
  const [originalPhotos, setOriginalPhotos] = useState<Photo[]>(initialPhotos);
  const [sortOption, setSortOption] = useState(getInitialSort());
  const [shuffleNonce, setShuffleNonce] = useState(0);
  const [loading, setLoading] = useState(initialPhotos.length === 0);
  const [flashing, setFlashing] = useState(false);
  const [pendingHashId, setPendingHashId] = useState<string | null>(null);
  const [lightboxReady, setLightboxReady] = useState(false);
  const [gridKey, setGridKey] = useState(0);
  const [cols, setCols] = useState(columnsForWidth);
  const [retries, setRetries] = useState<Record<string, number>>({});
  // Lazy initializer: laeuft im ersten Render, also solange der statische Grid steht.
  const [resumeDelay] = useState(runningCardInDelay);

  // Derived, not state: if `sortOption` and the sorted list could disagree for even
  // one render, the entrance delays would freeze against the pre-sort order.
  // `shuffleNonce` is a dependency only so re-picking "random" re-shuffles.
  const loadedPhotos = useMemo(
    () => sortPhotos(originalPhotos, sortOption),
    [originalPhotos, sortOption, shuffleNonce],
  );

  // Entrance state lives in refs on purpose: a re-render must never restart or
  // cut off a running card-in animation.
  const delaysRef = useRef(
    new Map<string, number>(
      resumeDelay === null ? [] : initialPhotos.map((photo) => [photo.id, resumeDelay]),
    ),
  );
  // Ohne eine der beiden Vorbelegungen faengt card-in beim Uebergang von vorne an
  // und der Grid blitzt weg: entweder die Einblendung laeuft weiter (negativer
  // Delay) oder sie war ohnehin schon durch (direkt als sichtbar markiert).
  const revealedRef = useRef(
    new Set<string>(resumeDelay === null ? initialPhotos.map((photo) => photo.id) : []),
  );
  const imgLoadedRef = useRef(new Set<string>());

  function resetEntranceState() {
    delaysRef.current.clear();
    revealedRef.current.clear();
    imgLoadedRef.current.clear();
  }

  // Delay is computed once per card and then frozen, so later renders keep it stable.
  function delayFor(id: string, index: number) {
    const known = delaysRef.current.get(id);
    if (known !== undefined) return known;
    const delay = Math.min(index, MAX_STAGGER) * STAGGER_STEP;
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
    } catch (err) {
      console.error("[PhotoGridClient] Error loading photos:", err);
    }
    setLoading(false);
  }

  // Nur der Notfall: images.json war beim Build leer, dann gibt es auch keinen
  // statischen Grid und der Skeleton ist die richtige Antwort.
  useEffect(() => {
    if (initialPhotos.length === 0) loadAndSetPhotos();
  }, []);

  // PhotoGrid.astro rendert denselben Grid statisch vor - sonst enthaelt das HTML
  // wegen client:only kein einziges <img> und Crawler sehen eine leere Seite. Ab
  // hier uebernimmt diese Komponente. Layout-Effekt, damit Entfernen und erster
  // eigener Paint im selben Frame liegen; ein normaler Effekt laesst dazwischen
  // eine leere Seite durch.
  useLayoutEffect(() => {
    if (originalPhotos.length > 0) document.querySelector("[data-static-grid]")?.remove();
  }, [originalPhotos.length]);

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

  // Kein Nachladen in Batches: PhotoGrid.astro schickt den ganzen Bestand schon
  // im HTML an jeden Besucher, das Batching hat danach nur noch versteckt, was
  // ohnehin im DOM stand - und die Bilder haengen am `loading="lazy"`, nicht daran.
  // ponytail: jenseits einiger hundert Bilder wieder batchen - dann aber auf
  // beiden Seiten, sonst blendet der Loader nur nach Refresh und Sortierwechsel auf.
  const visiblePhotos = loadedPhotos;

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
  }, [loadedPhotos]);

  // Hash-Open: Open only once and only if GLightbox is ready and not already open
  useEffect(() => {
    if (!pendingHashId || !lightboxReady) return;
    const index = loadedPhotos.findIndex((photo) => photo.id === pendingHashId);
    if (
      index >= 0 &&
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
    }
  }, [pendingHashId, loadedPhotos, lightboxReady]);

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
            ref={(el) => {
              // Gecachte Bilder sind fertig, bevor Preact den load-Listener setzt:
              // dann feuert onLoad nie und das <img> bliebe auf opacity 0 stehen.
              if (el?.complete && el.naturalWidth > 0) {
                imgLoadedRef.current.add(photo.id);
                el.closest(".photo")?.classList.add("loaded");
              }
            }}
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

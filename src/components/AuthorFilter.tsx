// "Whose shots?" above the grid. A native select: it needs no menu code of its own and
// works the way every phone already knows. The choice lives in the address (?author=),
// so a player's page can be shared. PhotoGridClient reads the same parameter.

import { useEffect, useRef, useState } from "preact/hooks";

type Props = { authors: [name: string, shots: number][]; total: number };

const fromUrl = () =>
  typeof window === "undefined" ? "" : (new URLSearchParams(window.location.search).get("author") ?? "");

export default function AuthorFilter({ authors, total }: Props) {
  const [author, setAuthor] = useState(fromUrl);
  const select = useRef<HTMLSelectElement>(null);

  // Heading and count live in static markup above the islands.
  useEffect(() => {
    // Hydration keeps the server's empty choice otherwise, whatever the address says.
    if (select.current) select.current.value = author;
    const heading = document.querySelector(".gallery-toolbar-title h2");
    if (heading) heading.textContent = author ? `Screenshots by ${author}` : "Screenshots";
    const count = document.querySelector(".gallery-count");
    const shots = author ? (authors.find(([name]) => name === author)?.[1] ?? 0) : total;
    if (count) count.textContent = `${shots} shots`;
  }, [author, authors, total]);

  const choose = (next: string) => {
    setAuthor(next);
    const url = new URL(window.location.href);
    if (next) url.searchParams.set("author", next);
    else url.searchParams.delete("author");
    history.replaceState(null, "", url);
    window.dispatchEvent(new CustomEvent("filterAuthor", { detail: { author: next } }));
  };

  return (
    <>
      <select
        ref={select}
        class="author-select"
        aria-label="Show screenshots by"
        value={author}
        onChange={(e) => choose(e.currentTarget.value)}
      >
        <option value="">All players</option>
        {authors.map(([name]) => (
          <option value={name} key={name}>
            {name}
          </option>
        ))}
      </select>
      {author && (
        <button type="button" class="author-reset" onClick={() => choose("")}>
          Show everyone
        </button>
      )}
    </>
  );
}

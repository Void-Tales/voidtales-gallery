// SortSelector component: Dropdown for gallery sorting. Keeps selection in sync with global state and refreshes.

import { useState, useEffect, useRef } from "preact/hooks";

// Extend Window type for global sort option
declare global {
  interface Window {
    __gallerySortOption?: string;
  }
}

// Sort options with labels and icons
const sortOptions = [
  { value: 'date-desc', label: 'Newest', icon: '↓' },
  { value: 'date-asc', label: 'Oldest', icon: '↑' },
  { value: 'name-asc', label: 'A - Z', icon: 'A' },
  { value: 'name-desc', label: 'Z - A', icon: 'Z' },
  { value: 'random', label: 'Random', icon: '🎲' },
];

// Function to get initial sort from localStorage or default
function getInitialSort(defaultSort: string): string {
  if (typeof window !== "undefined") {
    const stored = window.localStorage.getItem("gallerySortOption");
    if (stored && sortOptions.some(opt => opt.value === stored)) {
      return stored;
    }
    if (window.__gallerySortOption && sortOptions.some(opt => opt.value === window.__gallerySortOption)) {
      return window.__gallerySortOption;
    }
  }
  return defaultSort || "date-desc";
}

export default function SortSelector({ defaultSort = "date-desc" }: { defaultSort?: string }) {
  const [currentSort, setCurrentSort] = useState(defaultSort);
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Ref for dropdown options
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Set state only on client to prevent hydration issues
  useEffect(() => {
    setCurrentSort(getInitialSort(defaultSort));
  }, [defaultSort]);

  // Update global sort option, localStorage, and dispatch event
  const handleSortChange = (option: string) => {
    setCurrentSort(option);
    if (typeof window !== "undefined") {
      window.__gallerySortOption = option;
      window.localStorage.setItem("gallerySortOption", option);
      window.dispatchEvent(new CustomEvent('sortGallery', { detail: { sortOption: option } }));
    }
    setIsOpen(false);
  };

  // Toggle dropdown and set focus on active option when opening
  const toggleDropdown = () => {
    const newIsOpen = !isOpen;
    setIsOpen(newIsOpen);
    if (newIsOpen) {
      setTimeout(() => {
        const idx = sortOptions.findIndex(opt => opt.value === currentSort);
        if (optionRefs.current[idx]) {
          optionRefs.current[idx]?.focus();
        }
      }, 0);
    } else {
      buttonRef.current?.blur();
    }
  };

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (!(e.target as Element).closest('.sort-selector')) setIsOpen(false);
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  // Listen for refresh event and sync sort selection
  useEffect(() => {
    const handleRefresh = () => {
      setCurrentSort(getInitialSort(defaultSort));
    };
    window.addEventListener('refreshGallery', handleRefresh);
    return () => window.removeEventListener('refreshGallery', handleRefresh);
  }, [defaultSort]);

  const currentOption = sortOptions.find(opt => opt.value === currentSort);

  return (
    <div class={`sort-selector ${isOpen ? 'open' : ''}`}>
      <button
        ref={buttonRef}
        class="sort-btn"
        onClick={toggleDropdown}
        aria-label="Sort gallery"
        title="Sort gallery"
      >
        <span class="sort-icon">{currentOption?.icon}</span>
        <span class="sort-label">{currentOption?.label}</span>
        <svg class="dropdown-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d={isOpen ? "M6 9l6 6 6-6" : "M9 6l6 6 6-6"} />
        </svg>
      </button>
      <ul class="sort-dropdown">
        {sortOptions.map((option, idx) => (
          <li key={option.value}>
            <button
              ref={el => { optionRefs.current[idx] = el; }}
              class={`sort-option ${option.value === currentSort ? 'active' : ''}`}
              onClick={() => handleSortChange(option.value)}
            >
              <span class="sort-icon">{option.icon}</span>
              <span class="sort-label">{option.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
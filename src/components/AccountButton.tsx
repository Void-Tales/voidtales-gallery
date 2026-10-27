// Discord login / avatar in the header. Renders nothing while the API is
// unreachable, so a dead gallery-api never shows a login that can't work.

import { useEffect, useState } from "preact/hooks";
import { loadSocial, loginUrl, logout, useSocial } from "../utils/social.js";

const LOGIN_NOTICES: Record<string, string> = {
  "not-member": "Only members of the Void Tales Discord can like and comment.",
  "timed-out": "You're timed out on the Void Tales Discord, so you can't like or comment right now.",
  failed: "Discord login didn't work, please try again.",
};

// Straight on <body>: the header's backdrop-filter traps fixed children below
// GLightbox, and the API sends people back to #img-<id>, so it is open by now.
function showNotice(text: string) {
  const el = document.createElement("p");
  el.className = "account-notice";
  el.setAttribute("role", "status");
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

export default function AccountButton() {
  const social = useSocial();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    loadSocial();
    // The API sends failed logins back as ?login=<reason>; show it once, then drop it from the URL.
    const url = new URL(window.location.href);
    const reason = url.searchParams.get("login");
    if (reason) {
      showNotice(LOGIN_NOTICES[reason] ?? LOGIN_NOTICES.failed);
      url.searchParams.delete("login");
      history.replaceState(null, "", url);
    }
    const close = (e: MouseEvent) => {
      if (!(e.target as Element).closest(".account")) setOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  if (!social.available) return null;

  return (
    <div class={`account${open ? " open" : ""}`}>
      {social.me ? (
        <>
          <button
            type="button"
            class="account-btn"
            aria-expanded={open}
            aria-label={`Logged in as ${social.me.name}`}
            title={social.me.name}
            onClick={() => setOpen(!open)}
          >
            <img src={social.me.avatar} alt="" width={28} height={28} />
          </button>
          <div class="account-menu">
            <span class="account-name">{social.me.name}</span>
            {social.me.staff && <span class="account-staff">Staff</span>}
            <button
              type="button"
              class="account-logout"
              onClick={() => {
                setOpen(false);
                logout();
              }}
            >
              Log out
            </button>
          </div>
        </>
      ) : (
        <a class="account-login" href={loginUrl()} title="Log in with Discord to like and comment">
          Log in
        </a>
      )}
    </div>
  );
}

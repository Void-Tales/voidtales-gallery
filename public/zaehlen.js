// Einwilligung in die Besucherzählung (Umami, § 25 Abs. 1 TDDDG). Ohne Ja wird nichts geladen und nichts gezählt.
// Dieselbe Datei auf jeder Seite mit Umami (Vorlage: dettmer-it-website/src/scripts/zaehlen.js).
// Website-ID und Domain stehen an der Karte: <section data-zaehlen data-id="…" data-domains="…" hidden>.
// Die Wahl liegt in localStorage, das ist für die Einwilligung selbst nötig (§ 25 Abs. 2 Nr. 2 TDDDG).
(() => {
  const karte = document.querySelector('[data-zaehlen]');
  if (!karte) return;
  const SCHLUESSEL = 'zaehlen';
  const lesen = () => { try { return localStorage.getItem(SCHLUESSEL); } catch { return null; } };
  const merken = w => { try { localStorage.setItem(SCHLUESSEL, w); } catch {} };

  const laden = () => {
    if (document.querySelector('script[data-website-id]')) return;
    const s = document.createElement('script');
    s.defer = true;
    s.src = 'https://stats.hzwd.xyz/script.js';
    s.dataset.websiteId = karte.dataset.id;
    if (karte.dataset.domains) s.dataset.domains = karte.dataset.domains; // Vorschauen und lokale Builds zählen nie mit
    document.head.append(s);
  };

  let zurueck = null; // der Knopf, der die Karte geöffnet hat: nach der Antwort kommt der Fokus dorthin zurück
  const zeigen = () => {
    karte.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => karte.classList.add('da')));
  };
  karte.addEventListener('click', e => {
    const w = e.target.closest('[data-wahl]')?.dataset.wahl;
    if (!w) return;
    const vorher = lesen();
    merken(w);
    karte.hidden = true;
    karte.classList.remove('da');
    zurueck?.focus();
    zurueck = null;
    if (w === 'ja') laden();
    else if (vorher === 'ja') location.reload(); // Widerruf: neu laden, damit das schon geladene Skript weg ist
  });

  // Widerruf oder Meinung ändern: Knöpfe mit data-zaehlen-aendern (Fußzeile, Datenschutzerklärung) holen die Karte zurück.
  document.querySelectorAll('[data-zaehlen-aendern]').forEach(k => {
    k.hidden = false;
    k.addEventListener('click', () => { zurueck = k; zeigen(); karte.querySelector('button').focus(); });
  });

  const wahl = lesen();
  // Eine vorgeladene Seite (Speculation Rules) ist noch kein Besuch: erst zählen, wenn sie wirklich geöffnet wird
  if (wahl === 'ja') document.prerendering ? document.addEventListener('prerenderingchange', laden, { once: true }) : laden();
  else if (wahl !== 'nein') zeigen();
})();

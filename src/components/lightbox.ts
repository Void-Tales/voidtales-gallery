// Nachgeladen per import() aus PhotoGridClient, erst nach dem ersten Paint: GLightbox
// samt Skin war vorher render-blockierendes CSS und der Grossteil des Grid-Chunks.
// Das CSS per ?url und eigenem <link>: ein normaler CSS-Import zieht Astro fuer
// client:only-Inseln wieder als Stylesheet in den <head>, auch aus dynamischen Imports.
// Reihenfolge zaehlt, der Skin ueberschreibt glightbox.css.
import glightboxCss from "glightbox/dist/css/glightbox.css?url";
import skinCss from "../styles/lightbox.css?url";

for (const href of [glightboxCss, skinCss]) {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.append(link);
}

export { default } from "glightbox";

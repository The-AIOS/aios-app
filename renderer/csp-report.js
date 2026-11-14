'use strict';
/* The window's Content Security Policy (#162) refuses anything it was not told about. Say so in one greppable line, so
   `npm run smoke` fails on a refused file instead of the App quietly losing a feature. Fires for this document's own policy
   only, never a board's. Its own file, loaded FIRST, right after the policy: a listener at the end of app.js would miss a
   refusal of anything loaded before it, and the quick bar, which has no app.js, would log nothing. */
document.addEventListener('securitypolicyviolation', (e) => {
  console.error(`aios-csp-violation ${e.effectiveDirective || e.violatedDirective} ${e.blockedURI || '(inline)'}`);
});

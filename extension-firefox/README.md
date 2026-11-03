# Capture8K pour Firefox 2.6.0

Cette variante utilise directement le moteur Gecko de Firefox. L’option native
`tabs.captureVisibleTab({ scale })` rerastérise la page visible au facteur requis
pour obtenir un grand côté de 3 840 px (4K) ou 7 680 px (8K).

- aucun upscale IA ;
- aucun changement de viewport ou de media query ;
- aucun écran virtuel ;
- aucune API de débogage ;
- comparaison avant/après et certification par l’app macOS Capture8K.

Le raccourci est `⌘⇧8`. Le bouton **Dossier…** choisit l’emplacement de sortie.
Les pages internes de Firefox et certains contenus protégés ne sont pas
capturables.

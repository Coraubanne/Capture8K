# Capture8K 2.6.0 — extension Chrome + app macOS

Capture8K conserve désormais **100 % de la page visible**, sans couper le haut,
le bas ou les côtés. Le PNG préserve le ratio exact du viewport et son grand
côté mesure **3 840 px en 4K** ou **7 680 px en 8K**, sans agrandir
artificiellement une capture existante. La version 2.5.7 travaille directement sur le document déjà affiché,
sans dupliquer l’onglet ni recharger l’URL. Son mode Chrome dédié supprime la
barre technique qui réduisait brièvement le viewport des sites responsives.

## Utilisation

1. Lancer `Capture8K.app`. Si l’indicateur affiche **4K!** ou **8K!**, choisir
   **Préparer Chrome** dans l’extension ou **Relancer Chrome en mode Capture8K**
   dans le menu de l’app.
2. Accepter la relance unique de Chrome ; la dernière session est restaurée.
3. Ouvrir la page à capturer puis presser **⌘⇧8**, ou cliquer sur
   **Capturer la page visible** dans l’extension.
4. Le viewport visible complet est capturé, vérifié et enregistré.

Le bouton **Dossier…**, toujours disponible dans l’extension, ouvre directement le sélecteur macOS et
mémorise la destination des prochaines captures. Le menu de l’app permet aussi de choisir 4K ou 8K et
d’afficher ce dossier dans le Finder. Par défaut, les fichiers sont placés dans
`Téléchargements/Capture8K` et leur URL est copiée dans le presse-papiers.

## Architecture de fidélité

La capture suit quatre étapes :

1. L’app vérifie d’abord que Chrome a été lancé avec le mode qui désactive la
   barre de débogage responsable du changement de hauteur. Sinon, la capture est
   bloquée avant de toucher à la page.
2. La page et tous ses cadres intégrés sont figés : animations CSS/Web
   Animations, transitions et médias sont suspendus sans règle propre à un site.
3. Chrome contrôle jusqu’à 1 200 éléments visibles, attend deux géométries
   identiques, puis suspend le JavaScript.
4. Deux références visibles et deux témoins internes successifs doivent être
   stables. Leur comparaison est réalisée sur une grille de 640 × 360 pixels,
   avec une tolérance dédiée aux petites différences d’antialiasing entre les
   deux API de capture de Chrome. Un régulateur respecte aussi automatiquement
   la limite de deux captures visibles par seconde imposée par Chrome.
5. Le zoom Chrome est mesuré. Le rectangle CDP est aligné sur les dimensions
   physiques de la référence visible dans l’espace avant zoom. Aucune émulation
   de viewport ou de DPR n’est appliquée : la fenêtre, l’écran actif et les
   media queries restent ainsi identiques.
6. `Page.captureScreenshot` repeint directement ce même document avec un facteur
   de page calculé pour donner 3 840 ou 7 680 pixels au grand côté. Le ratio, la
   mise en page, le DPR et les media queries ne sont pas modifiés.
7. Un dernier témoin est produit après le rendu ; l’app macOS effectue ensuite
   une comparaison indépendante avant d’enregistrer atomiquement le PNG.

La longueur totale située hors écran est seulement consignée : les pages à
chargement paresseux peuvent la modifier sans changer le moindre pixel visible.
Seuls le viewport visible, son scroll, sa géométrie et ses pixels sont bloquants.

Il n’y a ni upscale IA, ni écran virtuel, ni copie d’onglet, ni rechargement, ni
scroll d’assemblage. Les images bitmap ne gagnent pas de détail au-delà de leur
fichier source ; le texte, les SVG, les bordures et le CSS sont en revanche
rerastérisés par Chrome à l’échelle de sortie.

## Garanties et limites

Un fichier marqué `certifie` possède le grand côté annoncé, conserve le ratio
du viewport visible et a passé les
contrôles géométriques et visuels. Si la page bouge entre les deux témoins ou si
Chrome ne produit pas les dimensions exactes, aucun faux 4K/8K n’est enregistré.
La phase de rendu dispose désormais de 26 secondes, ce qui laisse une enveloppe
pratique inférieure à 30 secondes pour la capture complète.

Pour les vidéos, mettre la lecture en pause avant la capture donne la meilleure
correspondance de frame. Les pages internes `chrome://`, le mode image dans
l’image et certains contenus protégés peuvent rester impossibles à capturer.

Le mode fidèle repose sur l’option Chrome
`--silent-debugger-extension-api`. Elle évite la barre qui déforme les pages,
mais la masque pour toutes les extensions disposant de l’autorisation
`debugger`. Il faut donc conserver uniquement des extensions de confiance.

Le menu de l’app propose aussi **Recharger Capture8K dans Chrome** afin
d’activer une nouvelle version de l’extension sans perdre la dernière session.

## Installation locale

- App : `~/Applications/Capture8K.app`
- Pont Chrome :
  `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.capture8k.native.json`
- Extension non empaquetée : dossier `Capture8K-Chrome`

Le raccourci **⌘⇧8** est déclaré directement dans Chrome afin de réveiller
l’extension de façon fiable. L’autorisation `debugger` donne accès à la surface
du document pendant la capture ; `nativeMessaging` transmet localement les trois
images de contrôle à l’app. Aucune donnée n’est envoyée sur Internet.

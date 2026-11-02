# Capture8K.app

Compagnon macOS natif de l’extension Capture8K 2.5.7.

- vérification et relance consentie de Chrome en mode de capture fidèle ;
- menu 4K / 8K dans la barre des menus ;
- réglages partagés avec le raccourci Chrome `⌘⇧8` ;
- dossier de destination personnalisable directement depuis l’extension ;
- réception locale des PNG par Native Messaging ;
- comparaison de la référence, du témoin direct et du rendu final ;
- contrôle 3840×2160 ou 7680×4320 ;
- écriture atomique et copie du fichier dans le presse-papiers.

Compilation sans Xcode complet :

```sh
./build.sh
```

Le bundle généré se trouve dans `build/Capture8K.app`. Le manifeste du pont
Chrome se trouve dans `Resources/com.capture8k.native.json`.

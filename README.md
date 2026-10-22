# F2VTT Map — by Ghilas

Carte collaborative des spots de VTT de la Métropole Européenne de Lille.
Site statique (GitHub Pages) + Supabase (base de données, photos, connexion).

## Structure

```
index.html
style.css
script.js
supabase.sql
assets/
  logo.png
```

## 1. Supabase

1. **SQL** : Supabase > *SQL Editor* > *New query*, colle `supabase.sql`, clique *Run*.
   Il crée la table, les règles de sécurité (RLS) et le bucket `spot-photos`.
   Tes spots existants sont conservés.
2. **Authentication > Sign In / Providers > Email** :
   - **Désactive « Confirm email »** (sinon les comptes restent bloqués en attente d'un email).
   - Laisse **« Allow new users to sign up »** activé : chaque personne crée son compte
     directement sur le site (nom, prénom, mot de passe, ville).
3. Il n'y a **aucun compte à créer à la main**.

Comment ça marche : Supabase exige un email, donc le site en fabrique un à partir du
prénom et du nom (`jean.dupont@f2vtt-map.com`). Aucun email n'est envoyé. Si Supabase
refuse ce domaine, change `EMAIL_DOMAIN` en haut de `script.js`.

Limites à connaître :
- Pas de « mot de passe oublié » par email : en cas d'oubli, réinitialise-le dans
  *Authentication > Users*.
- Deux personnes avec exactement le même nom et prénom ne peuvent pas avoir chacune un
  compte (ajoute une initiale ou un second prénom).
- Chacun ne modifie / supprime que ses propres spots. Les anciens spots (créés avant les
  comptes) restent modifiables par tout le monde. Pour te les attribuer, copie ton `UID`
  (*Authentication > Users*) puis lance :
  `update public.spots set created_by = 'TON-UID' where created_by is null;`

La clé `sb_publishable_…` dans `script.js` est publique par conception.
Ne copie jamais la clé `service_role` / `secret` dans le code.

## 2. Logo

Ajoute ton image dans `assets/logo.png`. Si le fichier manque, le site fonctionne
quand même (l'image est simplement masquée).

## 3. Publier sur GitHub Pages

1. Crée un dépôt GitHub et envoie-y tous les fichiers (dossier `assets/` compris).
2. *Settings > Pages* > *Deploy from a branch* > branche `main`, dossier `/ (root)`.
3. Après une minute, le site est disponible sur `https://TON-PSEUDO.github.io/NOM-DU-DEPOT/`.

## Notes

- Les anciennes photos stockées en base64 dans la table continuent de s'afficher.
  Dès qu'un spot est modifié et ré-enregistré, les nouvelles photos vont dans Storage.
- Les photos sont redimensionnées (1600 px max) et compressées avant l'envoi.
- Rotation : leaflet-rotate 0.2.3 (version déjà utilisée sur ton site). Pour changer de
  version, modifie l'URL dans `index.html`.

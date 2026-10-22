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
2. **Compte partagé** : *Authentication > Users > Add user > Create new user*.
   - Email : celui de ton choix (ex. `f2vtt@ton-mail.com`)
   - Mot de passe : le mot de passe d'accès au site (nouveau, fort)
   - Coche *Auto Confirm User*.
3. **Désactive les inscriptions publiques** : *Authentication > Sign In / Providers >
   Email* : désactive *Allow new users to sign up*. Sinon n'importe qui pourrait
   créer un compte et accéder aux spots.
4. Dans `script.js`, remplace `SHARED_EMAIL` par l'email du compte.

La clé `sb_publishable_…` dans `script.js` est publique par conception.
Ne copie jamais la clé `service_role` / `secret` dans le code.

## 2. Logo

Ajoute ton image dans `assets/logo.png`. Si le fichier manque, le site fonctionne
quand même (l'image est simplement masquée).

## 3. Publier sur GitHub Pages

1. Crée un dépôt GitHub et envoie-y tous les fichiers (dossier `assets/` compris).
2. *Settings > Pages* > *Deploy from a branch* > branche `main`, dossier `/ (root)`.
3. Après une minute, le site est disponible sur `https://f2vtt-map.github.io`.

## Notes

- Les anciennes photos stockées en base64 dans la table continuent de s'afficher.
  Dès qu'un spot est modifié et ré-enregistré, les nouvelles photos vont dans Storage.
- Les photos sont redimensionnées (1600 px max) et compressées avant l'envoi.
- Rotation : leaflet-rotate 0.2.3 (version déjà utilisée sur ton site). Pour changer de
  version, modifie l'URL dans `index.html`.

# BomShort

Fork privé et auto-hébergé de [mutonby/openshorts](https://github.com/mutonby/openshorts) : transforme
de longues vidéos (YouTube ou upload) en shorts verticaux 9:16 avec l'IA, puis les publie
automatiquement via une instance **Postiz** auto-hébergée.

Différences avec l'upstream :

- **Pas de site vitrine** : landing page, pages SEO, outils gratuits, pricing, bannières, analytics
  et cookies ont été supprimés. La page par défaut est le panel.
- **Authentification par mot de passe** : tout le backend (`/api`, `/videos`, `/thumbnails`, `/mcp`)
  est protégé. Session dans un cookie HttpOnly signé, limitation des tentatives de connexion.
- **Clés API stockées côté serveur uniquement** : saisies dans *Settings*, enregistrées dans
  `data/settings.json` (chmod 600) et ajoutées aux requêtes par le serveur. Le navigateur ne les
  reçoit jamais (seulement « définie / 4 derniers caractères »). Les en-têtes `X-*-Key` envoyés
  par un client sont ignorés.
- **Publication via Postiz** (remplace Upload-Post) : post immédiat, programmé ou brouillon sur
  n'importe quel canal connecté à Postiz (YouTube, TikTok, Instagram, X, LinkedIn…),
  « schedule week », AI Shorts, YouTube Studio (vidéo + miniature) et outil MCP `publish_clip`.
- **Auto-post** : à la fin de chaque job, les N meilleurs clips (score prédit) sont envoyés à
  Postiz automatiquement, espacés de X heures (ou en brouillon pour validation).

## Démarrage

```bash
cp .env.example .env
```

Définir au minimum `APP_PASSWORD` dans `.env` (sinon un mot de passe est généré au premier
démarrage et affiché une seule fois dans les logs du backend).

**Production** (nginx sert le panel et proxifie l'API sur la même origine) :

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

Panel sur `http://<serveur>:8080` (port modifiable avec `PANEL_PORT`). Mettre un reverse proxy
TLS (Caddy, Traefik…) devant : le cookie de session passe en `Secure` automatiquement en HTTPS.

**Développement** (hot reload) :

```bash
docker compose up --build
```

Panel sur `http://localhost:5175`.

## CI/CD (GitHub Actions + runner auto-hébergé)

`.github/workflows/ci.yml` :

- **backend-tests** et **frontend** (lint + build) tournent sur les runners GitHub, PR comprises.
- **deploy** tourne sur ton runner auto-hébergé, uniquement sur un push vers `main` (ou un
  lancement manuel), une fois les tests au vert. Il écrit `.env` depuis le secret `BOMSHORT_ENV`,
  lance `docker compose -f docker-compose.prod.yml up -d --build`, puis vérifie que le panel répond.

Secret à créer (Settings → Secrets and variables → Actions) : **`BOMSHORT_ENV`** = le contenu
complet du `.env` de production (au minimum `APP_PASSWORD`, et `PANEL_PORT` si 8080 est déjà pris
sur l'hôte).

### Un runner par dépôt sur le même hôte

Sur un compte GitHub personnel, un runner auto-hébergé n'appartient qu'à **un seul** dépôt, et un
dossier de runner ne se configure qu'une fois (« already configured »). Pour plusieurs dépôts sur
le même hôte Docker, on installe une instance par dépôt, chacune dans son dossier et avec son
service systemd ; elles partagent le même démon Docker :

```bash
# sur l'hôte Docker, avec l'utilisateur qui fait déjà tourner l'autre runner
TOKEN=$(gh api -X POST repos/Devantho/openshorts/actions/runners/registration-token --jq .token)
./ops/runner/install-runner.sh Devantho/openshorts "$TOKEN"
```

Le jeton (valable 1 h) est aussi affiché dans Settings → Actions → Runners → New self-hosted runner.
Les instances sont créées dans `~/actions-runners/<owner>__<repo>/`. Alternative : placer les
dépôts dans une organisation GitHub et y enregistrer un seul runner partagé.

## Configuration dans le panel (Settings)

1. **API keys** : Gemini (obligatoire pour le générateur de clips), ElevenLabs (doublage),
   fal.ai (AI Shorts).
2. **Postiz** : URL de l'instance (`https://postiz.example.com`, `…/api` ou `…/api/public/v1`)
   et clé de l'API publique (Postiz → Settings → Public API). « Save & test » vérifie la
   connexion et liste les canaux.
3. **Publishing defaults** : visibilité YouTube, confidentialité/mode TikTok, type Instagram,
   hashtags ajoutés à chaque post.
4. **Auto-post** : canaux, nombre de clips par job, délai avant le premier post, espacement,
   mode (programmé ou brouillon).
5. **Panel password** : changement du mot de passe (sauf s'il est fixé par `APP_PASSWORD`).

Les clés peuvent aussi venir de l'environnement (`GEMINI_API_KEY`, `ELEVENLABS_API_KEY`,
`FAL_KEY`, `POSTIZ_URL`, `POSTIZ_API_KEY`) : elles servent de valeur par défaut quand rien
n'est enregistré depuis le panel.

## Agents (MCP)

Le serveur MCP est sur `/mcp`. Définir `APP_API_TOKEN` dans `.env` et l'envoyer en
`Authorization: Bearer <token>`. Exemples de configuration dans *Settings → Connect an agent*.

## Données

| Chemin | Contenu |
|---|---|
| `data/settings.json` | clés API, config Postiz, préférences de publication |
| `data/auth.json` | hash scrypt du mot de passe, secret de signature des sessions |
| `output/` | jobs et clips (supprimés après `JOB_RETENTION_SECONDS`, 24 h par défaut) |

`data/` ne doit jamais être commité ni exposé (il est dans `.gitignore` et `.dockerignore`).

## Tests

```bash
pytest tests/
cd dashboard && npm run lint && npm run build
```

## Licence

MIT, comme le projet d'origine (voir `LICENSE` et `NOTICE`).

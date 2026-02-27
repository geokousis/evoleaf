# EvoLeaf

EvoLeaf is a customized self-hosted Overleaf Community Edition deployment based on the Overleaf Toolkit. It includes editor, compile, registration, package-management, and access-control changes on top of the standard CE stack.

## Base project

This project is based on the open-source Overleaf Toolkit and the Overleaf Community Edition codebase, with additional custom deployment, UI, and workflow changes specific to EvoLeaf.

## What this repo contains

- Overleaf Toolkit deployment config
- custom frontend and backend patches under `data/overleaf-patches/`
- local nginx gate configuration for shared access protection
- TeX package persistence helpers
- a tracked package list for rebuilding TeX Live additions after container recreation

## Custom features

### Suggestion and compile behavior

- suggestion-mode compile toggle in the compile menu
- suggestions remain visible in code view
- suggestions can be excluded from rendered output by default
- optional suggestion-aware compile path

### Review and UI changes

- custom suggestion/comment behavior
- review panel and editor JS patches
- custom `/install` page inside Overleaf

### In-app TeX package installer

- install TeX Live packages from inside the Overleaf UI
- package install progress and job log streaming
- queued installs so concurrent users do not run `tlmgr` at the same time
- successful packages saved to a persistent package list

### Package persistence helpers

Tracked package list:

- `config/tex-packages-installed.txt`

Runtime package list inside the container:

- `/var/lib/overleaf/system/tex-packages-installed.txt`

Reinstall saved packages after container recreation:

```bash
cd /media/storage/kousis/overleaf-toolkit
./bin/reinstall-tex-packages
```

Rotate the shared basic-auth password:

```bash
cd /media/storage/kousis/overleaf-toolkit
./bin/set-basic-auth-password overleaf 'NEW_STRONG_PASSWORD'
```

## Important files

### Deployment config

- [config/overleaf.rc](/media/storage/kousis/overleaf-toolkit/config/overleaf.rc)
- [config/docker-compose.override.yml](/media/storage/kousis/overleaf-toolkit/config/docker-compose.override.yml)
- [config/nginx/nginx.conf](/media/storage/kousis/overleaf-toolkit/config/nginx/nginx.conf)
- [config/variables.env.example](/media/storage/kousis/overleaf-toolkit/config/variables.env.example)

### Custom patches

- [data/overleaf-patches](/media/storage/kousis/overleaf-toolkit/data/overleaf-patches)

### Helper scripts

- [bin/reinstall-tex-packages](/media/storage/kousis/overleaf-toolkit/bin/reinstall-tex-packages)
- [bin/set-basic-auth-password](/media/storage/kousis/overleaf-toolkit/bin/set-basic-auth-password)

## Secrets

Do not commit live secrets.

Keep these out of git:

- `config/variables.env`
- `config/nginx/overleaf.htpasswd`
- tunnel tokens
- SMTP keys
- runtime data under `data/`

Use [config/variables.env.example](/media/storage/kousis/overleaf-toolkit/config/variables.env.example) as the template for a real local `config/variables.env`.

## Domain and access model

Current expected deployment shape:

1. Cloudflare Tunnel publishes `evo-leaf.com`
2. tunnel origin points to local nginx on `http://localhost:8080`
3. nginx applies shared basic auth
4. nginx proxies to Overleaf on the internal toolkit network

## Registration flow

This repo includes a custom public registration flow:

- `GET /register` shows an email form
- `POST /register` sends an activation email
- user sets password from the activation link

## Start or restart the stack

```bash
cd /media/storage/kousis/overleaf-toolkit
./bin/docker-compose up -d
```

Recreate the web container after patch/config changes:

```bash
cd /media/storage/kousis/overleaf-toolkit
./bin/docker-compose up -d --force-recreate sharelatex
```

## Notes

- this repo tracks customization code and safe deployment config
- this repo does not track user/project/database runtime data
- if `sharelatex` is recreated, use the package reinstall script to restore tracked TeX packages

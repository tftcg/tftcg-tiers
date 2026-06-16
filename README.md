# tftcg-tiers

Static Transformers TCG tier-site sources live under `docs/tiersite/`.

The site is generated directly from the OCTGN card data in `/workspace/octgn-data` and copies the images it uses into the published `docs/tiersite/assets/` tree.

## Regenerating the site data

From `/workspace/tftcg-tiers`:

```bash
python3 generate_site_data.py
```

You can also point it at specific OCTGN set folders or a parent folder that contains them:

```bash
python3 generate_site_data.py /workspace/octgn-data/Sets
python3 generate_site_data.py /workspace/octgn-data/Sets/b6128c63-c932-4abe-83b5-c9119b0a6915
```

That rebuilds:

- `docs/tiersite/data/manifest.js`
- `docs/tiersite/data/set.<wave>.js`
- `docs/tiersite/assets/background_primus4.png`
- `docs/tiersite/assets/cards/<octgn-set-id>/...`

## Notes

- Set switching maps directly to TFTCG waves and related sets such as `Outlier 1`.
- `Wave 10A` is merged into `Wave 10`, so it shares the same tier list instead of appearing as its own wave.
- Duplicate in-wave reprints are dropped during generation, including promo reprints and the repeated Wave 1 Energon Edition block.
- Characters, Stratagems, and Battle Cards each have their own tier state.
- Character and Stratagem flip sides persist per card within a wave.
- Character tabs are generated from common factions and traits in that wave.
- Battle Card tabs cover Weapon, Armor, Utility, Action, Secret Action, and Rolling Action.

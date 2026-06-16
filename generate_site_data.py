#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import shutil
import sys
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote


PRIMARY_BUCKETS = (
    ("characters", "Characters"),
    ("stratagems", "Stratagems"),
    ("battle-cards", "Battle Cards"),
)
CHARACTER_COMMONALITY_THRESHOLD = 3
SKIP_SET_NAMES = {"DEPRECATED SET", "Game Tokens"}
BATTLE_FILTER_ORDER = (
    ("Weapon", "Weapon"),
    ("Armor", "Armor"),
    ("Utility", "Utility"),
    ("Action", "Action"),
    ("Secret Action", "Secret Action"),
    ("Rolling Action", "Rolling Action"),
)
MERGED_SET_NAMES = {
    "Wave 10A": "Wave 10",
}
OUTPUT_ROOT = Path(__file__).resolve().parent / "docs" / "tiersite"
DATA_DIR = OUTPUT_ROOT / "data"
ASSETS_DIR = OUTPUT_ROOT / "assets"
CARD_ASSETS_DIR = ASSETS_DIR / "cards"
BACKGROUND_SOURCE = Path(__file__).resolve().parent.parent / "octgn-data" / "assets" / "background_primus4.png"
BACKGROUND_OUTPUT = ASSETS_DIR / "background_primus4.png"
SETS_DIR = Path(__file__).resolve().parent.parent / "octgn-data" / "Sets"


def normalize_whitespace(value: str) -> str:
    return re.sub(r"[ \t]+", " ", value).strip()


def split_csv(value: str) -> list[str]:
    return [piece.strip() for piece in value.split(",") if piece.strip()]


def slugify(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def load_xml(set_file: Path) -> ET.Element:
    return ET.parse(set_file).getroot()


def props_for(node: ET.Element) -> dict[str, str]:
    return {
        prop.attrib["name"]: prop.attrib.get("value", "")
        for prop in node.findall("property")
        if "name" in prop.attrib
    }


def wave_sort_key(name: str) -> tuple[object, ...]:
    wave_match = re.fullmatch(r"Wave (\d+)([A-Z]?)", name)
    if wave_match:
        return (0, int(wave_match.group(1)), wave_match.group(2) or "")

    outlier_match = re.fullmatch(r"Outlier (\d+)([A-Z]?)", name)
    if outlier_match:
        return (1, int(outlier_match.group(1)), outlier_match.group(2) or "")

    return (2, name)


def card_number_sort_key(card_number: str) -> tuple[object, ...]:
    match = re.fullmatch(r"([A-Z]*)(\d+)(?: ([A-Z0-9]+))?", card_number.strip())
    if not match:
        return (9, card_number)

    prefix, numeric, suffix = match.groups()
    return (0 if not prefix else 1, prefix, int(numeric), suffix or "")


def build_public_id(set_name: str) -> str:
    return slugify(set_name)


def canonical_set_name(set_name: str) -> str:
    return MERGED_SET_NAMES.get(set_name, set_name)


def encode_path_segments(*segments: str) -> str:
    return "/".join(
        quote(segment, safe="-_.()[]ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")
        for segment in segments
    )


def load_file_map(cards_dir: Path) -> dict[str, str]:
    if not cards_dir.is_dir():
        return {}
    return {entry.name.lower(): entry.name for entry in cards_dir.iterdir() if entry.is_file()}


def classify_primary_type(type_name: str) -> str | None:
    if type_name.startswith("Character -"):
        return "characters"
    if type_name == "Stratagem":
        return "stratagems"
    if type_name == "Token":
        return None
    return "battle-cards"


def extract_battle_filters(type_name: str) -> list[str]:
    if type_name == "Action":
        return ["Action"]
    if type_name == "Secret Action":
        return ["Secret Action"]
    if type_name == "Rolling Action":
        return ["Rolling Action"]

    filters = []
    if "Weapon" in type_name:
        filters.append("Weapon")
    if "Armor" in type_name:
        filters.append("Armor")
    if "Utility" in type_name:
        filters.append("Utility")
    return filters


def parse_star_cost(value: str) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def mode_label_for(type_name: str, *, has_alternates: bool, is_primary: bool) -> str:
    if type_name == "Stratagem" and has_alternates:
        return "Front" if is_primary else "Back"
    if type_name.startswith("Character - "):
        label = type_name.removeprefix("Character - ")
        if label.endswith(" Mode"):
            label = label[:-5]
        return label
    return type_name


def resolve_image_filename(
    file_map: dict[str, str],
    card_id: str,
    alternate_type: str | None,
) -> str | None:
    extensions = (".jpg", ".jpeg", ".png", ".webp")
    candidates: list[str] = []

    if alternate_type is None:
        candidates.extend(f"{card_id}{extension}" for extension in extensions)
    else:
        encoded = quote(alternate_type, safe="-_.()[]ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")
        raw = alternate_type
        candidates.extend(f"{card_id}.{encoded}{extension}" for extension in extensions)
        candidates.extend(f"{card_id}.{raw}{extension}" for extension in extensions)

    for candidate in candidates:
        actual = file_map.get(candidate.lower())
        if actual:
            return actual

    return None


def copy_card_image(set_dir_name: str, filename: str) -> str:
    source = SETS_DIR / set_dir_name / "Cards" / filename
    if not source.is_file():
        raise SystemExit(f"error: source image missing: {source}")

    destination_dir = CARD_ASSETS_DIR / set_dir_name
    destination_dir.mkdir(parents=True, exist_ok=True)
    destination = destination_dir / filename
    shutil.copy2(source, destination)
    return "assets/" + encode_path_segments("cards", set_dir_name, filename)


def copy_site_background() -> None:
    if not BACKGROUND_SOURCE.is_file():
        raise SystemExit(f"error: background image missing: {BACKGROUND_SOURCE}")
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy2(BACKGROUND_SOURCE, BACKGROUND_OUTPUT)


def build_mode_entry(
    node: ET.Element,
    *,
    set_dir_name: str,
    file_map: dict[str, str],
    card_id: str,
    primary_type: str,
    has_alternates: bool,
    is_primary: bool,
) -> dict:
    props = props_for(node)
    type_name = props.get("Type", primary_type if is_primary else "")
    alternate_type = None if is_primary else node.attrib.get("type")
    image_filename = resolve_image_filename(file_map, card_id, alternate_type)
    if image_filename is None:
        label_source = alternate_type or type_name or "primary"
        raise SystemExit(f"error: missing image for {card_id} ({label_source}) in {set_dir_name}")

    return {
        "label": mode_label_for(type_name, has_alternates=has_alternates, is_primary=is_primary),
        "type": type_name,
        "image": copy_card_image(set_dir_name, image_filename),
        "atk": props.get("ATK", ""),
        "def": props.get("DEF", ""),
        "hp": props.get("HP", ""),
        "stars": props.get("Stars", ""),
        "factions": split_csv(props.get("Faction", "")),
        "traits": split_csv(props.get("Traits", "")),
        "text": props.get("Text", ""),
    }


def unique_in_order(values: list[str]) -> list[str]:
    seen: set[str] = set()
    ordered = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        ordered.append(value)
    return ordered


def normalized_signature_props(node: ET.Element) -> tuple[tuple[str, str], ...]:
    return tuple(
        sorted(
            (key, normalize_whitespace(value))
            for key, value in props_for(node).items()
            if key != "Card Number"
        )
    )


def card_number_for(card: ET.Element) -> str:
    return props_for(card).get("Card Number", "")


def is_promo_card_number(card_number: str) -> bool:
    return card_number.startswith("P") or card_number.startswith("TP")


def card_content_signature(card: ET.Element) -> tuple[object, ...]:
    return (
        card.attrib.get("name", ""),
        card.attrib.get("size", ""),
        normalized_signature_props(card),
        tuple(
            (
                alternate.attrib.get("type", ""),
                alternate.attrib.get("name", ""),
                alternate.attrib.get("size", ""),
                normalized_signature_props(alternate),
            )
            for alternate in card.findall("alternate")
        ),
    )


def collect_duplicate_reprint_ids(cards: list[ET.Element]) -> set[str]:
    duplicate_ids: set[str] = set()
    seen_signatures: set[tuple[object, ...]] = set()
    for card in cards:
        signature = card_content_signature(card)
        if signature in seen_signatures:
            duplicate_ids.add(card.attrib["id"])
            continue
        seen_signatures.add(signature)
    return duplicate_ids


def collect_duplicate_promo_ids(cards: list[ET.Element]) -> set[str]:
    names_with_non_promos = {
        normalize_whitespace(card.attrib.get("name", ""))
        for card in cards
        if not is_promo_card_number(card_number_for(card))
    }
    return {
        card.attrib["id"]
        for card in cards
        if is_promo_card_number(card_number_for(card))
        and normalize_whitespace(card.attrib.get("name", "")) in names_with_non_promos
    }


def build_card_entry(card: ET.Element, set_dir_name: str, file_map: dict[str, str]) -> dict | None:
    props = props_for(card)
    primary_type = props.get("Type", "")
    bucket = classify_primary_type(primary_type)
    if bucket is None:
        return None

    card_id = card.attrib["id"]
    alternates = card.findall("alternate")
    has_alternates = bool(alternates)
    modes = [
        build_mode_entry(
            card,
            set_dir_name=set_dir_name,
            file_map=file_map,
            card_id=card_id,
            primary_type=primary_type,
            has_alternates=has_alternates,
            is_primary=True,
        )
    ]
    for alternate in alternates:
        modes.append(
            build_mode_entry(
                alternate,
                set_dir_name=set_dir_name,
                file_map=file_map,
                card_id=card_id,
                primary_type=primary_type,
                has_alternates=has_alternates,
                is_primary=False,
            )
        )

    factions = unique_in_order([value for mode in modes for value in mode["factions"]])
    traits = unique_in_order([value for mode in modes for value in mode["traits"]])

    return {
        "id": card_id,
        "number": props.get("Card Number", ""),
        "name": card.attrib.get("name", card_id),
        "rarity": props.get("Rarity", ""),
        "bucket": bucket,
        "primaryType": primary_type,
        "battleFilters": extract_battle_filters(primary_type),
        "starCost": parse_star_cost(props.get("Stars", "0")),
        "factions": factions,
        "traits": traits,
        "stratagemTarget": props.get("Stratagem Target", ""),
        "modes": modes,
    }


def count_commonalities(cards: list[dict], key: str) -> list[dict]:
    counts = Counter()
    for card in cards:
        counts.update(card.get(key, []))

    common = [
        {"label": label, "count": count, "value": label}
        for label, count in counts.items()
        if count >= CHARACTER_COMMONALITY_THRESHOLD
    ]
    common.sort(key=lambda entry: (-entry["count"], entry["label"]))
    return common


def build_set_payload(set_dirs: list[Path]) -> dict | None:
    roots = [load_xml(set_dir / "set.xml") for set_dir in set_dirs]
    raw_set_names = [root.attrib.get("name", set_dir.name) for root, set_dir in zip(roots, set_dirs)]
    canonical_name = canonical_set_name(raw_set_names[0])
    if canonical_name in SKIP_SET_NAMES:
        return None

    entries = []
    source_set_ids = []
    source_set_names = []
    source_cards = [
        card
        for root in roots
        for card in root.findall("./cards/card")
    ]
    duplicate_reprint_ids = collect_duplicate_reprint_ids(source_cards)
    duplicate_promo_ids = collect_duplicate_promo_ids(source_cards)
    for set_dir, root, raw_set_name in zip(set_dirs, roots, raw_set_names):
        if canonical_set_name(raw_set_name) in SKIP_SET_NAMES:
            continue
        cards_dir = set_dir / "Cards"
        file_map = load_file_map(cards_dir)
        source_set_ids.append(root.attrib.get("id", set_dir.name))
        source_set_names.append(raw_set_name)
        for card in root.findall("./cards/card"):
            if card.attrib["id"] in duplicate_reprint_ids or card.attrib["id"] in duplicate_promo_ids:
                continue
            entry = build_card_entry(card, set_dir.name, file_map)
            if entry is not None:
                entries.append(entry)

    if not entries:
        return None

    entries.sort(key=lambda card: (card_number_sort_key(card["number"]), card["name"], card["id"]))

    cards_by_bucket = {
        bucket_key: [card for card in entries if card["bucket"] == bucket_key]
        for bucket_key, _ in PRIMARY_BUCKETS
    }
    character_cards = cards_by_bucket["characters"]
    battle_cards = cards_by_bucket["battle-cards"]

    set_id = build_public_id(canonical_name)
    battle_views = []
    for label, filter_key in BATTLE_FILTER_ORDER:
        count = sum(1 for card in battle_cards if filter_key in card["battleFilters"])
        if count:
            battle_views.append(
                {
                    "key": f"filter:battle:{slugify(filter_key)}",
                    "label": label,
                    "bucket": "battle-cards",
                    "kind": "battle",
                    "value": filter_key,
                    "count": count,
                }
            )
    battle_tag_views = []
    star_card_count = sum(1 for card in battle_cards if card["starCost"] >= 1)
    if star_card_count:
        battle_tag_views.append(
            {
                "key": "filter:battle-tag:star-cards",
                "label": "Star Cards",
                "bucket": "battle-cards",
                "kind": "battle-tag",
                "value": "star-cards",
                "count": star_card_count,
            }
        )

    faction_views = [
        {
            "key": f"filter:character:faction:{slugify(entry['value'])}",
            "label": entry["label"],
            "bucket": "characters",
            "kind": "faction",
            "value": entry["value"],
            "count": entry["count"],
        }
        for entry in count_commonalities(character_cards, "factions")
    ]
    trait_views = [
        {
            "key": f"filter:character:trait:{slugify(entry['value'])}",
            "label": entry["label"],
            "bucket": "characters",
            "kind": "trait",
            "value": entry["value"],
            "count": entry["count"],
        }
        for entry in count_commonalities(character_cards, "traits")
    ]

    return {
        "meta": {
            "id": set_id,
            "name": canonical_name,
            "sourceSetIds": source_set_ids,
            "sourceSetNames": source_set_names,
            "asset": f"data/set.{set_id}.js",
            "cardCount": len(entries),
            "characterCount": len(character_cards),
            "stratagemCount": len(cards_by_bucket["stratagems"]),
            "battleCardCount": len(battle_cards),
        },
        "cards": entries,
        "characterFilters": {
            "factions": faction_views,
            "traits": trait_views,
        },
        "battleTypeFilters": battle_views,
        "battleTagFilters": battle_tag_views,
    }


def write_set_asset(set_id: str, payload: dict) -> None:
    output_file = DATA_DIR / f"set.{set_id}.js"
    output_file.write_text(
        "window.TFTCG_TIER_SITE_SETS = window.TFTCG_TIER_SITE_SETS || {};\n"
        + f"window.TFTCG_TIER_SITE_SETS[{json.dumps(set_id)}] = "
        + json.dumps(payload, indent=2, ensure_ascii=False)
        + ";\n",
        encoding="utf-8",
    )


def write_manifest(manifest: dict) -> None:
    output_file = DATA_DIR / "manifest.js"
    output_file.write_text(
        "window.TFTCG_TIER_SITE_MANIFEST = "
        + json.dumps(manifest, indent=2, ensure_ascii=False)
        + ";\n",
        encoding="utf-8",
    )


def cleanup_generated_assets() -> None:
    for path in DATA_DIR.glob("set.*.js"):
        path.unlink()
    if CARD_ASSETS_DIR.is_dir():
        shutil.rmtree(CARD_ASSETS_DIR)


def discover_set_dirs(args: list[str]) -> list[Path]:
    if not args:
        return sorted(path.parent for path in SETS_DIR.glob("*/set.xml"))

    discovered: dict[Path, Path] = {}
    for raw_arg in args:
        path = Path(raw_arg).expanduser().resolve()
        if path.is_file() and path.name == "set.xml":
            discovered[path.parent] = path.parent
            continue
        if path.is_dir():
            set_xml = path / "set.xml"
            if set_xml.is_file():
                discovered[path] = path
                continue
            for nested in path.glob("*/set.xml"):
                discovered[nested.parent] = nested.parent
            continue
        raise SystemExit(f"error: path not found: {path}")

    if not discovered:
        raise SystemExit("error: no OCTGN set directories found")
    return sorted(discovered.values())


def main(argv: list[str]) -> int:
    set_dirs = discover_set_dirs(argv[1:])
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    cleanup_generated_assets()
    copy_site_background()

    payloads = []
    grouped_set_dirs: dict[str, list[Path]] = {}
    for set_dir in set_dirs:
        root = load_xml(set_dir / "set.xml")
        raw_set_name = root.attrib.get("name", set_dir.name)
        canonical_name = canonical_set_name(raw_set_name)
        if canonical_name in SKIP_SET_NAMES:
            continue
        grouped_set_dirs.setdefault(canonical_name, []).append(set_dir)

    for canonical_name in sorted(grouped_set_dirs, key=wave_sort_key):
        payload = build_set_payload(grouped_set_dirs[canonical_name])
        if payload is None:
            continue
        payloads.append(payload)

    payloads.sort(key=lambda payload: wave_sort_key(payload["meta"]["name"]))
    latest_primary_wave = next(
        (
            payload["meta"]["id"]
            for payload in reversed(payloads)
            if payload["meta"]["name"].startswith("Wave ")
        ),
        payloads[-1]["meta"]["id"] if payloads else None,
    )
    for payload in payloads:
        write_set_asset(payload["meta"]["id"], payload)

    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "defaultSetId": latest_primary_wave,
        "sets": [payload["meta"] for payload in payloads],
    }
    write_manifest(manifest)
    print(f"Generated {len(payloads)} set payloads into {DATA_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

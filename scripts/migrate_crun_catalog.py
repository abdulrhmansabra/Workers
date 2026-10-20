#!/usr/bin/env python3
"""Safely migrate per-template Firestore documents into crun_template_catalog/catalog_v1.

Default mode is dry-run. Pass --apply to write, read-back verify, then delete old
per-template documents. The script refuses oversized catalogs and preserves a JSON backup.
"""
import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone

from google.cloud import firestore

PROJECT_ID = "aishorts-57d93"
COLLECTION = "crun_template_catalog"
CATALOG_ID = "catalog_v1"
MAX_SAFE_JSON_BYTES = 700 * 1024  # Conservative headroom below Firestore's 1 MiB limit.
PROVIDERS = {"kling", "bytedance", "vidu"}
TEMPLATE_FIELDS = [
    "aspect_ratio_options", "base_cost", "category", "cover_url", "created_at",
    "customization_config", "description", "duration_options", "id", "is_active",
    "last_synced_at", "name", "option_pricing", "preview_video_url",
    "pricing_version", "provider", "provider_cost", "provider_template_id",
    "raw_catalog", "resolution_options", "sort_order", "supported_options",
    "updated_at",
]

def is_map(value):
    return isinstance(value, dict)

def as_list(value):
    return value if isinstance(value, list) else []

def normalize(ref, source):
    provider = source.get("provider")
    provider_template_id = source.get("provider_template_id")
    if provider not in PROVIDERS or not provider_template_id:
        raise ValueError(
            f"Unexpected non-template document '{ref.id}': provider/provider_template_id missing"
        )

    customization = source.get("customization_config")
    customization = customization if is_map(customization) else {}
    raw = source.get("raw_catalog")
    if not is_map(raw):
        raw = {} if raw is None or raw == "" else {"original_value": raw}

    provider_cost = source.get("provider_cost", 0.0)
    try:
        provider_cost = float(provider_cost or 0.0)
    except (TypeError, ValueError):
        provider_cost = 0.0

    base_cost = source.get("base_cost", 0)
    if not isinstance(base_cost, (int, float)) or isinstance(base_cost, bool):
        base_cost = 0
    base_cost = int(base_cost)

    last_synced = source.get("last_synced_at")
    if not isinstance(last_synced, int) or isinstance(last_synced, bool):
        last_synced = int(time.time() * 1000)

    record = {
        "aspect_ratio_options": as_list(source.get("aspect_ratio_options")),
        "base_cost": base_cost,
        "category": source.get("category") if isinstance(source.get("category"), str) else "",
        "cover_url": source.get("cover_url") if isinstance(source.get("cover_url"), str) else "",
        "created_at": source.get("created_at"),
        "customization_config": {
            "allow_image_input": customization.get("allow_image_input") is True,
            "allow_prompt": customization.get("allow_prompt") is True,
            "allow_reference_video": customization.get("allow_reference_video") is True,
        },
        "description": source.get("description") if isinstance(source.get("description"), str) else "",
        "duration_options": as_list(source.get("duration_options")),
        "id": ref.id,
        "is_active": source.get("is_active") is True,
        "last_synced_at": last_synced,
        "name": source.get("name") if isinstance(source.get("name"), str) else "",
        "option_pricing": source.get("option_pricing") if is_map(source.get("option_pricing")) else {},
        "preview_video_url": source.get("preview_video_url") if isinstance(source.get("preview_video_url"), str) else "",
        "pricing_version": source.get("pricing_version") if isinstance(source.get("pricing_version"), int) else 1,
        "provider": provider,
        "provider_cost": provider_cost,
        "provider_template_id": str(provider_template_id),
        "raw_catalog": raw,
        "resolution_options": as_list(source.get("resolution_options")),
        "sort_order": source.get("sort_order") if isinstance(source.get("sort_order"), int) else 0,
        "supported_options": as_list(source.get("supported_options")),
        "updated_at": source.get("updated_at"),
    }
    # Guarantee exact top-level schema order/set.
    return {field: record[field] for field in TEMPLATE_FIELDS}

def json_default(value):
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="write unified doc, verify it, then delete old template docs")
    args = parser.parse_args()

    db = firestore.Client(project=PROJECT_ID)
    collection = db.collection(COLLECTION)
    catalog_ref = collection.document(CATALOG_ID)
    if catalog_ref.get().exists:
        print(f"STOP: {COLLECTION}/{CATALOG_ID} already exists. No changes made.")
        print("Inspect/backup that document and merge it deliberately before rerunning.")
        return 2

    refs = [ref for ref in collection.list_documents() if ref.id != CATALOG_ID]
    if not refs:
        print("STOP: no old template documents found; nothing to migrate.")
        return 2

    source_docs = []
    templates = {}
    for ref in refs:
        snap = ref.get()
        if not snap.exists:
            continue
        data = snap.to_dict() or {}
        source_docs.append({"id": ref.id, "data": data})
        templates[ref.id] = normalize(ref, data)

    backup_name = "crun_template_catalog_backup_" + datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S") + ".json"
    with open(backup_name, "w", encoding="utf-8") as backup:
        json.dump(source_docs, backup, ensure_ascii=False, indent=2, default=json_default)
    print(f"Backup written: {os.path.abspath(backup_name)}")
    print(f"Old documents: {len(source_docs)}")
    print(f"Templates normalized: {len(templates)}")

    candidate = {
        "catalog_version": 1,
        "updated_at": int(time.time() * 1000),
        "templates": templates,
    }
    estimated_size = len(json.dumps(candidate, ensure_ascii=False, separators=(",", ":"), default=json_default).encode("utf-8"))
    print(f"Estimated compact JSON size: {estimated_size:,} bytes ({estimated_size / 1024:.1f} KiB)")
    if estimated_size > MAX_SAFE_JSON_BYTES:
        print("STOP: candidate exceeds the conservative 700 KiB safety threshold.")
        print("No Firestore writes or deletes were performed. Reduce raw_catalog payloads or use multiple documents.")
        return 3

    required = set(TEMPLATE_FIELDS)
    for template_id, record in templates.items():
        missing = required - set(record)
        if missing:
            print(f"STOP: {template_id} is missing fields: {sorted(missing)}")
            return 4

    if not args.apply:
        print("DRY RUN ONLY: no Firestore documents were changed.")
        print("If the count and size look correct, rerun with --apply to create, verify, then delete old documents.")
        return 0

    candidate_ref = collection.document(CATALOG_ID)
    candidate_ref.create(candidate)
    saved = candidate_ref.get()
    saved_data = saved.to_dict() or {}
    saved_templates = saved_data.get("templates")
    if not isinstance(saved_templates, dict) or len(saved_templates) != len(templates):
        candidate_ref.delete()
        print("STOP: read-back verification failed; candidate document was removed and old docs were retained.")
        return 5

    for template_id, original in templates.items():
        saved_record = saved_templates.get(template_id)
        if not isinstance(saved_record, dict) or set(saved_record.keys()) != required:
            candidate_ref.delete()
            print(f"STOP: schema verification failed for {template_id}; candidate removed, old docs retained.")
            return 6
        if saved_record.get("provider_template_id") != original.get("provider_template_id"):
            candidate_ref.delete()
            print(f"STOP: identity verification failed for {template_id}; candidate removed, old docs retained.")
            return 7

    print(f"Verified {len(saved_templates)} templates in {COLLECTION}/{CATALOG_ID}.")
    # Only delete the original per-template documents, never any other collection.
    batch = db.batch()
    deleted = 0
    for ref in refs:
        batch.delete(ref)
        deleted += 1
        if deleted % 400 == 0:
            batch.commit()
            batch = db.batch()
    if deleted % 400:
        batch.commit()

    remaining = [ref.id for ref in collection.list_documents() if ref.id != CATALOG_ID]
    if remaining:
        print(f"WARNING: migration succeeded but {len(remaining)} old docs remain: {remaining[:20]}")
        return 8
    print(f"SUCCESS: unified catalog created; {deleted} old per-template documents deleted.")
    print(f"Keep the backup file: {os.path.abspath(backup_name)}")
    return 0

if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Генерирует data/sheet_template.csv из data/products.json.

Файл — заготовка первого листа Google-таблицы с товарами (колонки по SPEC §2.3;
имя листа не важно — сайт читает первый лист).
Пишется в UTF-8 с BOM, чтобы Google Sheets и Excel открыли кириллицу без вопросов.

Запуск: python tools/sheet_template.py
"""
import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "products.json"
DST = ROOT / "data" / "sheet_template.csv"

HEADERS = ["id", "Название", "Категория", "Описание", "Цена за 100 г", "В наличии", "Фото", "Порядок"]


def main() -> None:
    data = json.loads(SRC.read_text(encoding="utf-8"))
    categories = data["categories"]
    products = sorted(data["products"], key=lambda p: p["sort"])

    with DST.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f, lineterminator="\r\n")
        writer.writerow(HEADERS)
        for p in products:
            writer.writerow([
                p["id"],
                p["name"],
                categories.get(p["category"], p["category"]),   # русское название категории
                p.get("description", ""),
                "" if p.get("price") is None else p["price"],   # пусто = «цена по запросу»
                "да" if p.get("available", True) else "нет",
                "",                                             # пусто = images/{id}.jpg
                p["sort"],
            ])

    print(f"{DST.relative_to(ROOT)}: {len(products)} товаров")


if __name__ == "__main__":
    main()

# YAC1Sorter (Yet Another C1 Offer Sorter)

An unofficial, lightweight Firefox extension that adds filtering, sorting, and infinite auto-loading to **Capital One Offers** (`capitaloneoffers.com`).

> **Disclaimer:** This project is an independent, unofficial browser extension and is not affiliated with, endorsed by, or sponsored by Capital One.

## Features

* **Segmented Offer Filter (`All` | `X / %` | `Fixed Miles`):** Quickly isolate flat point/cashback offers (e.g., `22,500 miles`) from multiplier offers (e.g., `30X miles`).
* **Smart Sorting Dropdown:**
  * `Fixed 1st → Highest X`
  * `Highest X 1st → Fixed`
  * `High → Low` / `Low → High`
* **Carousel Unpacking & Deduplication:** Automatically surfaces high-value offers hidden inside horizontal carousels into the main grid and removes duplicate merchant tiles.
* **Auto-Load All Offers (`⏬ Load All Offers`):** Automatically clicks *"View More Offers"* until your entire offer feed is loaded on a single page.
* **100% Local & Private:** Collects zero user data, makes no external network requests, and runs strictly on `capitaloneoffers.com`.

## Installation (Firefox)

### Option 1: Load Temporarily (For Development / Quick Use)
1. Clone or download this repository:
   ```bash
   git clone [https://github.com/sahithiindarapu/yac1sorter.git](https://github.com/sahithiindarapu/yac1sorter.git)
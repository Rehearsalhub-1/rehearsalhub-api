# Complete PostgreSQL (Database) Dump — ERIC STEPHEN & Repertoire

---

## 👤 1. User Profile (`profiles` table)
| Field | Value in Postgres |
| :--- | :--- |
| **Name** | ERIC STEPHEN |
| **Email** | `takeshopstores@gmail.com` |
| **User ID (`id`)** | `8ILWjbl9IbgbuxBK9P23mB6pZBt1` |
| **Phone** | `09115216733` |
| **Avatar URL** | `https://res.cloudinary.com/dvtjjt3js/image/upload/v1781986989/p4hafwfit7dmcgm5olnj.jpg` |
| **KingsChat ID** | `687402000ba1d09e3e91b29c` |
| **Profile Completed** | `true` |
| **Auth Credential** | `YES` (Password Hash present) |
| **Created At** | `2025-12-01T11:49:03.690Z` |
| **Updated At** | `2026-08-01T17:15:41.289Z` |

---

## 🌍 2. Zone Memberships (`memberships` table) — 1 Zone Record
| Zone / Organization | Org ID | Role | Voice Part | Group / Church | Status | Joined Date |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Your Loveworld Singers** | `zone-001` | `MEMBER` | `NULL` | `NULL` | `ACTIVE` | `2026-08-24T17:09:03.432Z` |

> 🔴 **Discrepancy vs Firebase**:
> 1. `zone-088` (*Special Duty Zone*) membership is **missing**.
> 2. `voice_part` is `NULL` (Firebase has designation `Instrumentalist`).
> 3. `group_id` is `NULL` (Church `Celvz` / Subgroups not linked).

---

## ⛪ 3. Subgroups / Church Units (`groups` table) — 0 Records
* **Total Groups in Database**: **0** (Empty table in Postgres).
* *In Firebase, the user belongs to: `Bsbshsj`, `Test 1`, `cape twon 2`.*

---

## 💬 4. Chats (`chats` + `chat_participants` tables) — 22 Chats
| Chat ID | Type | Title / Participants | Total Members | Last Message |
| :--- | :--- | :--- | :--- | :--- |
| `group_zone_zone-001` | **GROUP** | **Your Loveworld Singers** | 138 members | "hello" |
| `group_zone_zone-088` | **GROUP** | **Special Duty Zone** | 15 members | *(No messages)* |
| `group_zone_zone-013` | **GROUP** | **Loveworld Singers India Zone** | 2 members | *(No messages)* |
| `dqHaObRKWPZJVST8PLdJ` | **GROUP** | **LWSRH Admin** | 5 members | *(No messages)* |
| `YX2DY3KxZYRVO21oGn41` | **GROUP** | **create hello** | 1 member | "sharersgym.com" |
| `8ILWjbl9IbgbuxBK9P23mB6pZBt1_Bn6ePxmPiWcYoU54OAgqu5F1O6b2` | **DIRECT** | DM with Nnenna Ekuma | 2 members | "📞 voice call started" |
| `8ILWjbl9IbgbuxBK9P23mB6pZBt1_Ct5AfqeJjXblh03sM5ibFndi2AB2` | **DIRECT** | DM with TOLULOPE AINA | 2 members | *(No messages)* |
| `8ILWjbl9IbgbuxBK9P23mB6pZBt1_IS6DHsWw8Zh1yEzsmpHHq1u255u1` | **DIRECT** | DM with ADMIN ADMIN | 2 members | "📞 voice call started" |
| `8ILWjbl9IbgbuxBK9P23mB6pZBt1_Phlc0Jvc4gaKxsqmmDK0eoSRts72` | **DIRECT** | DM with As He Is As He is | 2 members | *(No messages)* |
| `8ILWjbl9IbgbuxBK9P23mB6pZBt1_fjKn6C6OjZdnQSW1udz7oLzDYBk2` | **DIRECT** | DM with hi why | 2 members | "👤 Contact: Ephraim" |
| `8ILWjbl9IbgbuxBK9P23mB6pZBt1_g73bxwlqr8YQaSgELPpI0Wz2HqJ2` | **DIRECT** | DM with samsaxofficial... | 2 members | *(No messages)* |
| `8ILWjbl9IbgbuxBK9P23mB6pZBt1_h7TSoUvnExa4oaUjJ1dlU7q96XT2` | **DIRECT** | DM with Ephraim Udoji | 2 members | "This message was deleted" |
| `dKcOFZ4TOcnef96aQt7L` | **DIRECT** | DM with Ephraim Udoji | 2 members | *(No messages)* |
| `YH8Bnwl2XVRWhDuKMXzq` | **DIRECT** | DM with Annette Stephen | 2 members | "📵 Missed voice call" |
| `lEuiEFLsf7ZQQrHIkbre` | **DIRECT** | DM with Uche Melody | 2 members | *(No messages)* |
| `KNIFVmyZk9YVryr3lxVC` | **DIRECT** | DM with Eric Stephen | 2 members | *(No messages)* |
| *+ 6 legacy direct chats* | **DIRECT** | Legacy chats (`6WC6DJ...`, `KLR2F4...`, `jM86Oz...`, etc.) | 2 members | "hello" / "great" |

---

## ✉️ 5. Activity, Favorites & Playlists (`playlists` & `playlist_items` tables)
* **Messages Authored (`messages` table)**: **93 messages** authored in Postgres.
* **Playlists (`playlists` table)**: **8 playlists**
  1. **"Favorite Songs"** (ID: `8ILWjbl9IbgbuxBK9P23mB6pZBt1`) — 4 songs (`145UcEKbhq32nXOojdiR`, `DJaNMkck6O5qOIGMWhyA`, `0ChSaYabFVMJGShkr0ur`, `cmcM7biYDjNhZobw6G6C`)
  2. **"HS"** (ID: `c3MH2EmKdtQd4NJ4aGpg`) — 2 songs (`k65GHtycZGr0kKiq8JYt`, `JcoOb8g3oYFB0leGAGZd`)
  3. **"My daily"** (ID: `VyhhSFVVT7P87rWNBAfz`) — 4 songs (`145UcEKbhq32nXOojdiR`, `keQAd1eeEyqzcRPh4mSw`, `DJaNMkck6O5qOIGMWhyA`, `k65GHtycZGr0kKiq8JYt`)
  4. **"Liked Videos"** (ID: `8ILWjbl9IbgbuxBK9P23mB6pZBt1_liked`) — 0 songs
  5. **"Watch Later"** (ID: `8ILWjbl9IbgbuxBK9P23mB6pZBt1_watch_later`) — 0 songs
  6. **"hello"** (ID: `w0KiV1DerHJOBQcTq7EM`) — 0 songs
  7. **"hello"** (ID: `gYAzDxpFebzfPyzNjPLI`) — 1 song
  8. **"praise"** (ID: `r1pLZtPmfiTYE1BGc7le`) — 4 songs
* **Attendance Records (`attendances` table)**: **34 check-ins** recorded.
* **Submitted Songs (`submitted_songs` table)**: **3 songs** ("praise the lord", "HELLO", "glory" — all approved).

---

## 📦 6. Program Data & Repertoire in Postgres

### Total Database Entities in Postgres:
* **Organizations (`organizations`)**: 100
* **Programs (`programs`)**: 162
* **Songs (`songs`)**: 3,374
* **Program Song Links (`program_songs`)**: 3,757
* **Global Categories (`categories`)**: **0** *(table empty)*
* **Groups / Subgroups (`groups`)**: **0** *(table empty)*

---

## 📋 7. Deep Dive: `HSLHS JULY 2026` in Postgres

* **Program in Postgres**: `"HSLHS JULY 2026 PRE-REHEARSAL"` (ID: `cMVkUCqdfEnIIIzGbhfR`)
* **Organization**: Special Duty Zone (`zone-088`)
* **Category / Status**: `countdown` / `ongoing`
* **Attached Songs (`program_songs`)**: **53 Songs**
* **🔴 Song Order Bug**: **All 53 songs have `order = 1`**!
* **Categories on Attached Songs**: Only 3 categories mapped:
  1. `NEW HEALING SONGS` (9 songs)
  2. `NEW PRAISE SONGS` (23 songs)
  3. `COMBINED CATEGORY OF HEARD SONGS (MARCH HSLHS)` (21 songs)

> 🔴 **Missing in Postgres**:
> The main **HQ Program (`be9omJOzoGWS7WLjVs5f`)** with its **140 songs**, **16 category sections**, and **rehearsal comments** is completely missing from `programs` and `program_songs`.

---

## 📜 8. Song History & Comments in Postgres

* **`song_history` Table**: 0 records (table not populated).
* **Rehearsal History / Instructions**: The extensive date-stamped rehearsal transcripts from Pastor are not present in Postgres because `comments` were stored as embedded JSON arrays in Firebase rather than a dedicated relational table.

"""IMD-120 auto-scorer for D1 (Presencia /20) and D2 (Tecnología /20)."""
from __future__ import annotations

import re

import httpx

_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 Chrome/120.0"
)
_TIMEOUT = 15


async def _fetch_html(url: str) -> tuple[str | None, int, str]:
    headers = {"User-Agent": _USER_AGENT}
    try:
        async with httpx.AsyncClient(
            follow_redirects=True, timeout=_TIMEOUT, headers=headers
        ) as client:
            response = await client.get(url)
            return response.text, response.status_code, str(response.url)
    except httpx.ConnectError as exc:
        if "SSL" in str(exc) or "certificate" in str(exc).lower():
            try:
                async with httpx.AsyncClient(
                    follow_redirects=True,
                    timeout=_TIMEOUT,
                    headers=headers,
                    verify=False,
                ) as client:
                    response = await client.get(url)
                    return response.text, response.status_code, str(response.url)
            except Exception:
                pass
        return "", 0, url
    except Exception:
        return "", 0, url


def _score_d1(html: str, status_code: int, final_url: str) -> tuple[float, dict]:
    lower = html.lower()
    breakdown: dict[str, int | None] = {}

    # Web/3
    if 200 <= status_code < 300:
        breakdown["Web"] = 3
    elif 300 <= status_code < 400:
        breakdown["Web"] = 2
    else:
        breakdown["Web"] = 0

    # SSL/2
    breakdown["SSL"] = 2 if final_url.startswith("https://") else 0

    # Mob/3
    breakdown["Mob"] = 3 if 'name="viewport"' in lower or "name='viewport'" in lower else 0

    # GBP/3 — cannot auto-check
    breakdown["GBP"] = None

    # SEO/3
    has_title = "<title" in lower
    has_desc = 'name="description"' in lower or "name='description'" in lower
    if has_title and has_desc:
        breakdown["SEO"] = 3
    elif has_title:
        breakdown["SEO"] = 1
    else:
        breakdown["SEO"] = 0

    # Soc/3
    social_domains = [
        "instagram.com",
        "facebook.com",
        "tiktok.com",
        "twitter.com",
        "x.com",
        "youtube.com",
        "linkedin.com",
    ]
    breakdown["Soc"] = 3 if any(d in lower for d in social_domains) else 0

    # ES/3
    es_signals = ['lang="es"', "lang='es'", 'hreflang="es"', "hreflang='es'", "/es/", "español"]
    breakdown["ES"] = 3 if any(s in lower for s in es_signals) else 0

    total = sum(v for v in breakdown.values() if v is not None)
    return total, breakdown


def _score_d2(html: str) -> tuple[float, dict]:
    lower = html.lower()
    breakdown: dict[str, int] = {}

    # Bk/5
    booking_keywords = [
        "calendly.com",
        "jane.app",
        "patientpop",
        "simplybook.me",
        "vagaro",
        "mindbodyonline",
        "booker.",
        "zocdoc",
        "booksy",
        "healow",
        "book appointment",
        "book a consultation",
        "schedule appointment",
        "request appointment",
    ]
    breakdown["Bk"] = 5 if any(kw in lower for kw in booking_keywords) else 0

    # Ch/4
    chat_keywords = [
        "tidio",
        "tidiochat",
        "intercomcdn",
        "intercom.io",
        "drift.com",
        "livechatinc",
        "zdassets",
        "zopim",
        "hs-scripts.com",
        "podiumsite",
        "birdeye",
        "manychat",
        "crisp.chat",
    ]
    breakdown["Ch"] = 4 if any(kw in lower for kw in chat_keywords) else 0

    # Fm/3
    breakdown["Fm"] = 3 if "<form" in lower else 0

    # Pg/3
    internal_link_count = len(re.findall(r'href=["\']/', html, re.IGNORECASE))
    if internal_link_count >= 8:
        breakdown["Pg"] = 3
    elif internal_link_count >= 4:
        breakdown["Pg"] = 2
    elif internal_link_count >= 1:
        breakdown["Pg"] = 1
    else:
        breakdown["Pg"] = 0

    # At/3
    automation_keywords = ["mailchimp", "klaviyo", "convertkit", "activecampaign"]
    has_automation_platform = any(kw in lower for kw in automation_keywords)
    has_email_capture = 'type="email"' in lower or "type='email'" in lower
    has_submit = 'type="submit"' in lower or "type='submit'" in lower or "<button" in lower
    breakdown["At"] = 3 if (has_automation_platform or (has_email_capture and has_submit)) else 0

    # VC/2
    vc_keywords = [
        "virtual consultation",
        "virtual visit",
        "telehealth",
        "video consultation",
        "virtual consult",
        "online consultation",
    ]
    breakdown["VC"] = 2 if any(kw in lower for kw in vc_keywords) else 0

    total = sum(breakdown.values())
    return total, breakdown


async def auto_score(website_url: str) -> dict:
    """Fetch the given website and auto-score D1 and D2.

    Returns a dict with keys:
      d1_score, d2_score, d1_breakdown, d2_breakdown, total_auto, error

    d1_breakdown and d2_breakdown are dicts with subcriteria name → score achieved.
    """
    html, status_code, final_url = await _fetch_html(website_url)

    if not html and status_code == 0:
        return {
            "d1_score": 0,
            "d2_score": 0,
            "d1_breakdown": {},
            "d2_breakdown": {},
            "total_auto": 0,
            "error": f"Failed to fetch {website_url}",
        }

    d1_score, d1_breakdown = _score_d1(html, status_code, final_url)
    d2_score, d2_breakdown = _score_d2(html)

    return {
        "d1_score": d1_score,
        "d2_score": d2_score,
        "d1_breakdown": d1_breakdown,
        "d2_breakdown": d2_breakdown,
        "total_auto": d1_score + d2_score,
        "error": None,
    }

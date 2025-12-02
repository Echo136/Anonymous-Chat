
from playwright.sync_api import sync_playwright, expect
import time

def verify_typing_indicator(page1, page2):
    # Setup: Create room with page1
    page1.goto("http://localhost:3000")
    page1.get_by_role("button", name="Create room").click()

    # Wait for room creation and get URL
    invite_link_locator = page1.locator("#result a")
    invite_link_locator.wait_for()
    room_url = invite_link_locator.get_attribute("href")

    # Join room with page1
    page1.goto(room_url)
    page1.fill("#username", "Alice")
    page1.click("#joinBtn")
    page1.wait_for_selector("#chatUI", state="visible")

    # Join room with page2
    page2.goto(room_url)
    page2.fill("#username", "Bob")
    page2.click("#joinBtn")
    page2.wait_for_selector("#chatUI", state="visible")

    # Page1 types
    page1.type("#msg", "Hello")

    # Verify typing indicator on Page2
    indicator = page2.locator("#typingIndicator")
    expect(indicator).to_contain_text("Alice is typing...")

    # Take screenshot of Page2 showing the indicator
    page2.screenshot(path="/home/jules/verification/typing_indicator.png")

    # Page1 stops typing (sends message)
    page1.click("#sendBtn")

    # Verify indicator gone on Page2
    expect(indicator).to_be_empty()

if __name__ == "__main__":
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        # We need two contexts to simulate two users
        context1 = browser.new_context()
        context2 = browser.new_context()
        page1 = context1.new_page()
        page2 = context2.new_page()

        try:
            verify_typing_indicator(page1, page2)
            print("Verification successful!")
        except Exception as e:
            print(f"Verification failed: {e}")
            # Take screenshot on failure for debug
            page2.screenshot(path="/home/jules/verification/failure.png")
        finally:
            browser.close()

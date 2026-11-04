"""Capture a VNC server's screen with classic VNC authentication.

usage: python3 vncshot.py HOST::PORT OUT.png   (the password in VNC_PASSWORD)

macOS Screen Sharing also offers Apple's Diffie-Hellman authentication, which
takes an account password, and vncdotool picks it whenever it is offered, so
only the classic VNC authentication, which the Screen Sharing password
serves, is kept. The `mac` script runs this with vncdotool's own interpreter.
"""

import os
import sys
import time

from vncdotool import api, rfb

rfb.RFBClient.SUPPORTED_AUTHS = {rfb.AuthTypes.NONE, rfb.AuthTypes.VNC_AUTHENTICATION}
server, out = sys.argv[1], sys.argv[2]
client = api.connect(server, password=os.environ["VNC_PASSWORD"], timeout=30)
# The first framebuffer a fresh connection sees is black; the real content
# arrives with the following updates, so give them a moment.
client.refreshScreen()
time.sleep(2)
client.captureScreen(out)
client.disconnect()
api.shutdown()

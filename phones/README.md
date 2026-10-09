# phones/ - Yealink desk phones

Standard handset: **Yealink SIP-T31P**. From its datasheet (read 7 Oct 2026): 2 SIP accounts, PoE 802.3af
class 1 at 3 to 4 W, auto-provisioning over FTP, TFTP, HTTP or HTTPS, HTTPS certificate manager, SRTP,
TLS 1.3, OpenVPN. Two 10/100 ports. No power adapter in the box; PoE feeds it.

## How a phone gets its config

1. **At a desk in PMC.** The UDM's DHCP hands out option 66 = `https://pbx.pmcne.ph/prov/`. The phone asks
   for `/prov/<its MAC>.cfg` with its own username and password and gets its file.
2. **Anywhere else.** Yealink's free Remote Provisioning Service (RPS) holds the phone's MAC and our URL;
   on first boot the phone asks Yealink, is redirected to our URL, and continues as above. RPS is requested
   from Yealink by support ticket (yealink.com, read 7 Oct 2026). Every MAC PMC buys goes into RPS.
3. **Credentials on first contact.** The phone's first request carries no password; the server answers
   401. For the very first provisioning of a phone, its provisioning username (the MAC) and password are
   entered once on the phone, or the phone is first provisioned on the LAN. After that the file itself
   carries `static.auto_provision.server.username/password`, so every later pull is authenticated.
   Phase 3 decides which of the two first-contact routes PMC uses; both work with the current server.

## Files

`app/gen.js` writes one `<mac>.cfg` per phone. The common model file (`y000000000XXX.cfg`) is not used,
so the T31P's model number does not matter; the phone's request for it gets a 404, which Yealink tolerates.
The phone also pulls `phonebook.xml` as a remote phonebook named PMC.

## What the first phone must prove (phase 3 gate)

- Registers over TLS on 5061 with SRTP: `asterisk -rx "pjsip show contacts"` lists it, `pjsip show channelstats`
  shows SRTP during a call.
- The Yealink parameter names in `gen.js` are accepted: the phone shows the display name, the BLF key lights
  for the other test phone, the PMC phonebook opens.
- Time shows Manila.

## Security on the phone

`static.security.trust_certificates = 1` makes the phone check our certificate against its built-in CA list;
the wildcard pmcne.ph certificate is from a public CA, so nothing is installed on the phone. The admin web
password of the phone itself is set by provisioning in phase 5 (parameter `static.security.user_password`),
never left at the factory default.

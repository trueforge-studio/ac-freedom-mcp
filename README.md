# AC Freedom MCP

Control Kendal air conditioners from an MCP client. This Node.js and TypeScript server uses stdio and supports AUX Cloud for units registered in AC Freedom as well as BroadLink UDP for compatible local modules.

A Kendal ASM-09 was tested with AUX Cloud. For other units, cloud inventory shows whether the product ID matches the supported write profile. Local access depends on the Wi-Fi module and firmware.

## Install

Use Node.js 22 or later. From a checkout of this repository, run:

```sh
npm ci --omit=peer --ignore-scripts
npm run build
cp .env.example .env
```

Keep your email, password, device identifiers, IP address, and MAC address in your private configuration. The example file contains placeholders.

## Set up AUX Cloud

1. Set `AC_TRANSPORT=cloud` in `.env`. Set `AC_CLOUD_REGION` to `usa` for Other areas, `eu` for Europe, or `cn` for China.
2. Run `npm run cloud-list` and enter your AC Freedom email and password. The terminal hides the password, and the command does not save it. The helper uses Zsh. On a system without Zsh, configure credentials in the local environment and run `node dist/index.js --cloud-list`.
3. Find your air conditioner by its name in AC Freedom. Copy its `endpoint` to `AC_CLOUD_ENDPOINT` and its `product` to `AC_CLOUD_PRODUCT` in `.env`.
4. Run `npm run cloud-probe` to read the current state. With credentials already configured, you can also run `node dist/index.js --cloud-probe`.
5. Set `AC_CLOUD_WRITE=1` if the inventory reports `compatibleWriteProfile: true` and you want to enable control. Before writing, the server checks the product ID returned by AUX Cloud and verifies the resulting state after each command.

For regular use, the MCP client needs `AC_CLOUD_EMAIL` and `AC_CLOUD_PASSWORD` in its private environment. On macOS, use `AC_CLOUD_KEYCHAIN_SERVICE` instead of storing the password in `.env`. Create a generic password in Keychain with the same service name and your AC Freedom email as the account. The interactive probe and inventory accept an alternate environment file, for example `npm run cloud-probe -- /private/path/cloud.env`.

## Set up BroadLink LAN control

Set `AC_MAC` in `.env` and run `npm run probe` from the same network as the air conditioner. The server checks the local neighbor table and, if necessary, sends a BroadLink discovery message. If the unit does not appear, set `AC_IP` to the private IPv4 address shown in your router and retry. The probe authenticates and queries the unit over UDP port 80. Ambient temperature can be unavailable. Some AC Freedom modules respond only through AUX Cloud.

The LAN server starts in read-only mode. To enable controls, copy `profile.example.json` to a private file, set `AC_PROFILE_FILE` to its absolute path, and restart the MCP client. Enable the options you have confirmed on your unit.

| Profile field | Values |
| --- | --- |
| `power` | Set to `true` to enable on and off. |
| `temperature` | Set the confirmed `min`, `max`, and `step`. The adapter accepts 16–32 °C and steps of 1 or 0.5 °C. |
| `modes` | `auto`, `cool`, `heat`, `dry`, `fan` |
| `fanSpeeds` | `auto`, `low`, `medium`, `high`, `turbo`. For automatic speed, set `autoFanCode` to the value observed on your device, either 0 or 5. |
| `swingAxes` | `vertical`, `horizontal` |
| `features` | `display`, `sleep`, `health`, `mildew` |

LAN commands send a full state frame. The server reads the current state, updates the requested fields, and reads the state again. It serializes requests in each MCP process. Use one controller at a time when testing to avoid changes from the remote or app during the update.

## Connect your MCP client

Use absolute paths. The server reads `.env` from the project directory regardless of the client's working directory.

```json
{
  "mcpServers": {
    "kendal": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/ac-freedom-mcp/dist/index.js"]
    }
  }
}
```

If the environment file lives outside the checkout, put `--env-file=/private/path/cloud.env` before the path to `dist/index.js`. Run `npm run build` after changing the source so the client starts the updated build.

For a LAN installation you can also run the server on a host in the air conditioner's network. A remote MCP client can launch it using `ssh -T` over a private VPN.

## Tools

| Tool | Purpose |
| --- | --- |
| `ac_get_status` | Read power, operating mode, target and ambient temperature, fan speed, swing, and reported features. |
| `ac_list_capabilities` | See what the device reports and which controls are enabled. An inactive flag alone does not confirm a feature can be switched on. |
| `ac_power` | Turn the unit on or off. |
| `ac_set_temperature` | Change the setpoint. The tested cloud profile accepts 16–32 °C in 0.5 °C increments with the unit set to Celsius. |
| `ac_set_mode` | Choose cooling, heating, drying, fan-only, or automatic mode. |
| `ac_set_fan_speed` | Choose an available speed. AUX Cloud supports quiet, low, medium, high, turbo, and auto on the tested profile. |
| `ac_set_swing` | Control up/down or left/right swing. |
| `ac_set_feature` | Toggle reported features such as display, Sleep, Health, and mildew prevention. The compatible cloud profile also exposes Eco and the Power Limit switch. |

If you want to monitor room temperature with the unit off, compare readings over time while it is plugged in. A single reading can be the last value reported by the unit.

## AC Freedom app features

- **Countdown** can turn an active unit off after an interval. The app shows options such as 30, 60, and 90 minutes.
- **Booking** schedules power on or off by time and day. A power-on schedule can include temperature, mode, fan speed, swing, display, Health, Sleep, Eco, and Power Limit.
- **Favorite Modes** store startup settings. **Power-on operation** applies the favorite when the unit turns on.
- **Sleep Curve** and the **Power Limit percentage** are configured in the app.

The MCP server handles immediate controls. Use the app to create or manage its native timers, favorites, sleep curves, and power limit percentages.

## Development

Run `npm test` to build the server and test MCP tool registration, device discovery, and verified writes with a simulated unit.

The cloud adapter uses the HTTPS client from [Homebridge AUX Cloud](https://github.com/fparrav/homebridge-aux-cloud). The local adapter uses the LAN module from [Homebridge AC Freedom](https://github.com/azadaydinli/homebridge-ac-freedom/blob/main/src/broadlink-api.js). Further references include the [Kendal Wi-Fi setup guide](https://images.jumpseller.com/store/eita/31360003/attachments/dfe3603c11b34fda38d770958b945d19/Instrucciones_Wi_fi_2024_Kendal.pdf?1756240272=) and the [AUX Cloud device profiles](https://github.com/maeek/ha-aux-cloud/blob/main/custom_components/aux_cloud/devices.py).

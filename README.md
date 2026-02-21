# Live2D-Puppet-Link
Designed to be controlled by AI agent. Simple Live2D frontend with UI pose, animation manager and REST api for remote control the model. 

![demo](demo.gif)
※ Model in the sample gif is <code>SDちくわちゃん</code> by [入鹿ぱる @@pal156](https://x.com/pal156)

## Feature
- Pose manager
- Animation manager
- Parameter name override
- Animation queue/schedule
- Audio lip sync
- Subtitles display
- REST api for remote control the model

## NOTE

- This software architecture is designed by me and **implemented by AI agent**. It is not intended to be used as a production-ready product. It is provided as-is without any warranty. Use at your own risk.
- This software is a part of my personal project (Emil), there might be no maintenance or updates in the future based on my personal schedule.

## 1. Setup

### 1.1. Prepare the libs

Due to licensing restrictions, this repo cannot include the Live2D libraries by default. Download the files and place them in the <code>frontend/lib</code> directory.

- <code>live2dcubismcore.min.js</code> : Live2D Cubism Core
- <code>pixi.min.js</code> : PixiJS 5.3.3
- <code>cubism4.min.js</code> : Cubism 4 SDK 0.4.0

### 1.2. Prepare your live2d model.

You will need to place the directory of your live2d model in the <code>frontend</code> directory. The model directory must have <code>YOURMODEL.model3.json</code> and <code>YOURMODEL.cdi3.json</code>. (<code>YOURMODEL</code> can be any other name based on your model)

### 1.3 Edit the config file (frontend/settings.json)

<pre>
{
    "idle_timeout": 5,
    "queue_poll_interval": 200,
    "default_zoom": 0.35,
    "model_path": "YOURMODEL/YOURMODEL.model3.json",
    "background_video": "YOURMODEL/background.mp4",
    "background_image": "YOURMODEL/background.jpg",
    "profiles_path": "YOURMODEL/profiles.json",
    "scenes_path": "YOURMODEL/scenes.json",
    "extras": [
        {
            "endpoint": "http://localhost:8001/test1",
            "endpointName": "local arr",
            "refreshTime": 1000,
            "proxy": true,
            "hideOnErr": false,
            "data": [
                {
                    "key": "aa",
                    "name": "Sample label"
                },
                {
                    "key": "sub.subVal",
                    "name": "Sample label2"
                },
                {
                    "key": "sub",
                    "name": "obj"
                },
                {
                    "key": "dsjdks",
                    "name": "nonenonoe"
                }
            ]
        }
    ]
}
</pre>

#### Top-level parameters

| Key | Type | Description |
|-----|------|-------------|
| `idle_timeout` | number | Seconds of inactivity before the model automatically switches to the `idle` profile (falls back to `default` if `idle` does not exist). |
| `queue_poll_interval` | number | Milliseconds between each `/api/queue` poll to the backend. Lower = more responsive, higher = less network traffic. Default: `200`. |
| `default_zoom` | number | Initial scale applied to the Live2D model. `1.0` = full size; `0.35` = 35% size. |
| `model_path` | string | Path to the model's `.model3.json` file, relative to the `frontend/` directory. |
| `background_video` | string | *(optional)* Path to a background video file, relative to `frontend/`. Played as a looping background. |
| `background_image` | string | *(optional)* Path to a fallback background image, relative to `frontend/`. Used when no video is set. |
| `profiles_path` | string | Path to the `profiles.json` file, relative to `frontend/`. If the file does not exist, the server will create a new one when you create a new profile in the web UI. |
| `scenes_path` | string | Path to the `scenes.json` file, relative to `frontend/`. If the file does not exist, the server will create a new one when you create a new scene in the web UI. |
| `extras` | array | *(optional)* List of external data sources to display on screen. See below. |

#### `extras[]` — per-item parameters

<code>extras</code> is an optional feature that displays data from external REST endpoints in the bottom-left corner of the screen. The web client sends a GET request to each configured endpoint and displays the value extracted at the path defined by <code>key</code>.

Each object in the `extras` array defines one data source group displayed on the overlay.

| Key | Type | Description |
|-----|------|-------------|
| `endpoint` | string | Full URL of the REST endpoint to fetch data from. |
| `endpointName` | string | Display name shown as the group header on the overlay. |
| `refreshTime` | number | Milliseconds between each auto-refresh of the endpoint. |
| `proxy` | boolean | If `true`, the request is routed through the backend's `/api/extrasProxy` to avoid browser CORS restrictions. |
| `hideOnErr` | boolean | If `true`, individual rows (and the whole group on a fetch error) are hidden instead of showing `-`. |
| `data` | array | List of values to extract and display from the response JSON. |

#### `extras[].data[]` — data item parameters

| Key | Type | Description |
|-----|------|-------------|
| `key` | string | Dot-separated path to the value in the JSON response. Supports nested objects (`sub.subVal`) and array indexing (`[0].id`, `[2]`). Must resolve to a primitive (string, number, boolean); objects and arrays are treated as errors. |
| `name` | string | Label shown next to the value on the overlay. |


### 1.4 Parameter mappings (optional)
- By default, all parameters found in <code>YOURMODEL.cdi3.json</code> are displayed in the settings panel.
- By creating a file called <code>parameter_wrapper.json</code> inside the YOURMODEL directory, you can enable the parameter mapping feature.
- If <code>parameter_wrapper.json</code> exists, only the parameters defined in this file will be shown in the web UI, overriding the default list from <code>YOURMODEL.cdi3.json</code>.

#### Structure of <code>parameter_wrapper.json</code>

The file is a JSON object where each **top-level key** is a group name (e.g. `"Eyes"`, `"Mouth"`). Groups are used purely for organization and are shown as section headers in the settings panel.
> **Note:** The top-level group names (e.g. `"Toggles"`, `"Eyes"`, `"Mouth"`) are user-definable — you can name them anything you like.

Inside each group, each **key** is the exact Live2D parameter ID as found in your model (e.g. `"ParamEyeLOpen"`). The value is an object with a `"name"` field containing the human-readable label to display in the UI.

Example of <code>parameter_wrapper.json</code>
<pre>
{
    "Toggles": {
        "Param23": {
            "name": "Eye reflection transparency"
        },
        "Param25": {
            "name": "Hair pin transparency"
        },
        "Param40": {
            "name": "White pupil"
        },
        "Param26": {
            "name": "Bell transparency"
        },
        "Param27": {
            "name": "Choker transparency"
        },
        "Param24": {
            "name": "Ribbon transparency transparency"
        },
        "Param41": {
            "name": "Hair choroke transparency"
        },
        "Param42": {
            "name": "Cat ears and tail transparency"
        }
    },
    "Eyes": {
        "Param36": {
            "name": "Eyebrow"
        },
        "Param43": {
            "name": "Eyelash"
        },
        "ParamBrowLForm": {
            "name": "Left eyebrow form"
        },
        "ParamBrowRForm": {
            "name": "Right eyebrow form"
        },
        "ParamEyeLSmile": {
            "name": "Left eye smile"
        },
        "ParamEyeRSmile": {
            "name": "Right eye smile"
        },
        "ParamEyeLOpen": {
            "name": "Left eye open"
        },
        "ParamEyeROpen": {
            "name": "Right eye open"
        },
        "ParamEyeBallX": {
            "name": "Eye ball x"
        },
        "ParamEyeBallY": {
            "name": "Eye ball y"
        }
    },
    "Mouth": {
        "ParamMouthForm": {
            "name": "Mouth form"
        },
        "ParamMouthOpenY": {
            "name": "Mouth open y"
        }
    },
    "Hair": {
        "Param32": {
            "name": "Hair front"
        },
        "Param33": {
            "name": "Hair side"
        },
        "Param34": {
            "name": "Hair back"
        }
    },
    "Head": {
        "ParamAngleX": {
            "name": "Head x"
        },
        "ParamAngleY": {
            "name": "Head y"
        },
        "ParamAngleZ": {
            "name": "Head z"
        }
    },
    "Body": {
        "ParamBodyAngleX": {
            "name": "Body x"
        },
        "ParamBodyAngleY": {
            "name": "Body y"
        },
        "ParamBodyAngleZ": {
            "name": "Body z"
        }
    }
}
</pre>

## 2. Run

### 2.1 Start the backend
<pre>
# Navigate to the backend directory
cd backend

# Create a Python virtual environment (first time only)
python3 -m venv venv

# Activate the virtual environment
source venv/bin/activate

# Install dependencies (first time only)
pip install -r requirements.txt

# Start the server
uvicorn main:app --reload --host 0.0.0.0 --port 8000
</pre>

Alternatively, you can use the provided script:
<pre>
cd backend
source venv/bin/activate
bash ./start.sh
</pre>

### 2.2 Open the frontend

Open your browser and navigate to:
<pre>
http://localhost:8000
</pre>

## 3. REST API

This software provides a REST API to manage and control the model remotely. See the [API documentation](./API_DOCUMENTATION.md) for details.
const proto = location.protocol === "https:" ? "wss" : "ws";
const ws = new WebSocket(`${proto}://${location.host}`);

const createBtn = document.getElementById("create");
createBtn.disabled = true;

const joinBtn = document.getElementById("join");
joinBtn.disabled = true;

const errormsg = document.getElementById("errormsg");

const errorList = {
    "not-found": "No room with that code. Check the digits and try again.",
    "full":  "That room already has two people."
}

ws.addEventListener("open", () => {
    console.log("connected")
    createBtn.disabled = false;
    joinBtn.disabled = false;
});

ws.addEventListener("message", (e) => {
    const data = JSON.parse(e.data);
    
    if (data.type === "error") {
        errormsg.textContent = errorList[data.reason];
    }

    if (data.type === "room-created") {
        document.querySelector(".room-screen").hidden = false;
        document.querySelector(".home-screen").hidden = true;
        document.querySelector("#copycode").textContent = data.code;
    }

    if (data.type === "room-joined") {
        console.log("Room joined");
    }

    console.log(data);
}) 

ws.addEventListener("close", () => {
    console.log("disconnected");
    createBtn.disabled = true;
})

createBtn.addEventListener("click", () => {
    ws.send(JSON.stringify({ type: "create-room" }));
})

joinBtn.addEventListener("click", () => {
    const codeInput = document.getElementById("roomcode");

    ws.send(JSON.stringify({
        type: "join-room",
        code: codeInput.value      
    }))
})
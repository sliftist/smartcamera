import * as path from "path";
import { writePassword, readPassword } from "../src/password";

const PASSWORD_FILE = path.join(__dirname, "..", "actions", "password.json");

function main() {
    const given = process.argv[2];
    if (given === undefined) {
        console.log(readPassword(PASSWORD_FILE)
            ? `A password is set. Everything needs it, including the page and the websocket.`
            : `No password is set, so nothing is required to connect.`);
        console.log(``);
        console.log(`  yarn password <password>   set or replace it`);
        console.log(`  yarn password ""           remove it`);
        return;
    }
    writePassword(PASSWORD_FILE, given);
    if (given) {
        console.log(`Password set. It takes effect on the next request; no restart needed.`);
        console.log(`Callers send it as "Authorization: Bearer <password>", or ?password= on the websocket.`);
    } else {
        console.log(`Password removed. Nothing is required to connect now.`);
    }
}

main();

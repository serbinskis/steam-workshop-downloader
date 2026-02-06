function formatBytes(bytes, after) {
    var sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    if (bytes == 0) { return "0 Bytes"; }
    var i = parseInt(Math.floor(Math.log(bytes)/Math.log(1024)));
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? after : 0) + " " + sizes[i];
}


$("input").on("input", async () => {
    $("#workshop-card")[0].style = "visibility: hidden";
    $("#download-button")[0].innerHTML = "Download";
    var id = ($("input")[0].value.match(/\d+/) || [])[0];
    if (isNaN(id)) { return; }

    var result = await new Promise(resolve => {
        $.ajax({
            url: `/info/${id}`,
            type: "GET",
            contentType: false,
            processData: false,
            error: (data) => resolve(JSON.parse(data.responseText)),
            success: (data) => resolve(data),
        });
    });

    console.log(result);
    if (!result || result?.data[0]?.result != 1) { return; }

    $("#download-button")[0].setAttribute("workshop_id", id);
    $("#download-button")[0].href = `/downlaod/${id}`;
    $("#workshop-img")[0].src = result.data[0].preview_url;
    $("#workshop-img")[0].parentNode.href = `http://steamcommunity.com/sharedfiles/filedetails/?id=${id}`;
    $("#workshop-title")[0].innerHTML = result.data[0].title;
    $("#workshop-title")[0].parentNode.href = `http://steamcommunity.com/sharedfiles/filedetails/?id=${id}`;
    $("#workshop-created")[0].innerHTML = new Date(result.data[0].time_created*1000).toLocaleString("sv-SE");
    $("#workshop-updated")[0].innerHTML = new Date(result.data[0].time_updated*1000).toLocaleString("sv-SE");
    $("#workshop-size")[0].innerHTML = `Size: ~ ${formatBytes(result.data[0].file_size, 2)}`;
    $("#workshop-card")[0].style = "";
    console.log(result);
});


$("#download-button").on("click", async () => {
    $("#download-button")[0].innerHTML = "Preparing..."
    $("#download-button")[0].disabled = true;
    var id = $("#download-button")[0].getAttribute("workshop_id");

    var result = await new Promise(resolve => {
        $.ajax({
            url: `/prepare/${id}`,
            type: "GET",
            contentType: false,
            processData: false,
            error: (data) => resolve(data.status),
            success: (data) => resolve(data.code),
        });
    });

    $("#download-button")[0].innerHTML = (result == 200) ? "Download" : ((result == 503) ? "Busy" : "Failed");
    $("#download-button")[0].disabled = false;
    if (result != 200) { return; }

    var link = document.createElement("a");
    link.href = `/download/${id}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
});
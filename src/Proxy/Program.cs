// A plain YARP reverse proxy: the browser talks to app.localhost:5100,
// the proxy forwards to the app at Proxy:Destination.
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddReverseProxy()
    .LoadFromConfig(builder.Configuration.GetSection("ReverseProxy"));

var app = builder.Build();
app.MapReverseProxy();
app.Run();

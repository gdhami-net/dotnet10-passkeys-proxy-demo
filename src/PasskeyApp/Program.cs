using Microsoft.AspNetCore.Components.Authorization;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using PasskeyApp.Components;
using PasskeyApp.Components.Account;
using PasskeyApp.Data;

var builder = WebApplication.CreateBuilder(args);

// Add services to the container.
builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();

builder.Services.AddCascadingAuthenticationState();
builder.Services.AddScoped<IdentityRedirectManager>();
builder.Services.AddScoped<AuthenticationStateProvider, IdentityRevalidatingAuthenticationStateProvider>();

builder.Services.AddAuthentication(options =>
    {
        options.DefaultScheme = IdentityConstants.ApplicationScheme;
        options.DefaultSignInScheme = IdentityConstants.ExternalScheme;
    })
    .AddIdentityCookies();

var connectionString = builder.Configuration.GetConnectionString("DefaultConnection") ?? throw new InvalidOperationException("Connection string 'DefaultConnection' not found.");
builder.Services.AddDbContext<ApplicationDbContext>(options =>
    options.UseSqlite(connectionString));
builder.Services.AddDatabaseDeveloperPageExceptionFilter();

builder.Services.AddIdentityCore<ApplicationUser>(options =>
    {
        options.SignIn.RequireConfirmedAccount = true;
        options.Stores.SchemaVersion = IdentitySchemaVersions.Version3;
    })
    .AddEntityFrameworkStores<ApplicationDbContext>()
    .AddSignInManager()
    .AddDefaultTokenProviders();

builder.Services.AddSingleton<IEmailSender<ApplicationUser>, IdentityNoOpEmailSender>();

// The fix: the passkey identity comes from configuration, not from the Host header.
// Unset (the template's default), Identity uses Request.Host.Host.
builder.Services.Configure<IdentityPasskeyOptions>(builder.Configuration.GetSection("Passkeys"));

var app = builder.Build();

// Demo only: create the SQLite schema on start so every run begins from an empty database.
using (var scope = app.Services.CreateScope())
{
    scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Database.Migrate();
}

// The other route the demo tests: trust X-Forwarded-Host from the proxy.
if (app.Configuration.GetValue<bool>("Proxy:UseForwardedHeaders"))
{
    var forwarded = new ForwardedHeadersOptions
    {
        ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto | ForwardedHeaders.XForwardedHost,
    };
    foreach (var host in app.Configuration.GetSection("Proxy:AllowedHosts").Get<string[]>() ?? [])
    {
        forwarded.AllowedHosts.Add(host);
    }
    app.UseForwardedHeaders(forwarded);
}

// Demo only: log the host Identity will see on every passkey call.
app.Use(async (context, next) =>
{
    if (context.Request.Path.StartsWithSegments("/Account/PasskeyCreationOptions") ||
        context.Request.Path.StartsWithSegments("/Account/PasskeyRequestOptions"))
    {
        var passkeyOptions = context.RequestServices.GetRequiredService<Microsoft.Extensions.Options.IOptions<IdentityPasskeyOptions>>().Value;
        app.Logger.LogInformation("Passkey options for {Path}: Request.Host={Host}, ServerDomain={ServerDomain}, Origin={Origin}",
            context.Request.Path, context.Request.Host.Value, passkeyOptions.ServerDomain ?? "(null)", context.Request.Headers.Origin.ToString());
    }
    await next();
});

// Configure the HTTP request pipeline.
if (app.Environment.IsDevelopment())
{
    app.UseMigrationsEndPoint();
}
else
{
    app.UseExceptionHandler("/Error", createScopeForErrors: true);
    // The default HSTS value is 30 days. You may want to change this for production scenarios, see https://aka.ms/aspnetcore-hsts.
    app.UseHsts();
}
app.UseStatusCodePagesWithReExecute("/not-found", createScopeForStatusCodePages: true);
app.UseHttpsRedirection();

app.UseAntiforgery();

app.MapStaticAssets();
app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode();

// Add additional endpoints required by the Identity /Account Razor components.
app.MapAdditionalIdentityEndpoints();

app.Run();
